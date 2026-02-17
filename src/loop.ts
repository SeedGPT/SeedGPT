import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { cloneRepo, commitAndPush, createBranch, resetWorkspace } from './tools/git.js'
import { awaitChecks, cleanupStalePRs, closePR, deleteRemoteBranch, mergePR, openPR } from './tools/github.js'
import { storeReflection } from './agents/memory.js'
import { connectToDatabase, disconnectFromDatabase } from './database.js'
import logger, { writeIterationLog } from './logger.js'
import { plan } from './agents/plan.js'
import { PatchSession } from './agents/build.js'
import { FixSession } from './agents/fix.js'
import { reflect } from './agents/reflect.js'
import { setIterationId } from './llm/api.js'

export async function run(): Promise<void> {
	logger.info('SeedGPT starting iteration...')

	await connectToDatabase()

	try {
		await cleanupStalePRs()
		await cloneRepo()

		let merged = false
		while (!merged) {
			merged = await iterate()
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		try {
			await storeReflection(`Iteration crashed before reflection could run. Error: ${message}`)
		} catch { /* Swallowed because the crash itself may have been caused by a DB failure */ }
		throw error
	} finally {
		await disconnectFromDatabase()
	}
}

async function iterate(): Promise<boolean> {
	setIterationId(randomUUID())

	const { plan: iterationPlan, messages: plannerMessages } = await plan()
	logger.info(`Planned: "${iterationPlan.title}" — ${iterationPlan.description}`)

	const session = new PatchSession(iterationPlan)
	const branchName = await createBranch(iterationPlan.title)

	let edits = await session.createPatch()
	let prNumber: number | null = null
	let merged = false
	let outcome: string
	let fixer: FixSession | null = null

	if (edits.length === 0) {
		outcome = 'Builder produced no edits.'
		logger.warn(outcome)
	} else {
		await commitAndPush(iterationPlan.title)
		prNumber = await openPR(branchName, iterationPlan.title, iterationPlan.description)
		logger.info(`Opened PR #${prNumber}.`)

		let fixAttempt = 0
		while (true) {
			const result = await awaitChecks()
			if (result.passed) {
				merged = true
				outcome = `PR #${prNumber} merged successfully.`
				logger.info(outcome)
				break
			}

			fixAttempt++
			const error = result.error ?? 'CI checks failed with unknown error'

			if (!fixer) {
				const { created, modified } = session.editedFiles
				fixer = new FixSession({
					planTitle: iterationPlan.title,
					planDescription: iterationPlan.description,
					planImplementation: iterationPlan.implementation,
					createdFiles: created,
					modifiedFiles: modified,
				})
			}

			if (fixer.exhausted) {
				outcome = `CI failed (attempt ${fixAttempt}, no budget left): ${error.slice(0, config.errors.maxLoopErrorChars)}`
				logger.error(outcome)
				break
			}

			logger.warn(`CI failed (attempt ${fixAttempt}), attempting fix: ${error.slice(0, 500)}`)

			try {
				edits = await fixer.fix(error)
			} catch (error) {
				outcome = `Fixer failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`
				logger.error(outcome)
				break
			}

			if (edits.length === 0) {
				outcome = 'Fixer produced no fix edits.'
				logger.warn(outcome)
				break
			}

			await commitAndPush(`fix: ${iterationPlan.title}`)
			logger.info(`Pushed fix commit (attempt ${fixAttempt}).`)
		}
	}

	if (merged) {
		await mergePR(prNumber!)
		await deleteRemoteBranch(branchName).catch(() => {})
		logger.info(`PR #${prNumber} merged, branch deleted. Change is now on main.`)
	}

	await resetWorkspace()

	if (!merged) {
		if (prNumber !== null) {
			await closePR(prNumber)
			await deleteRemoteBranch(branchName).catch(() => {})
			logger.error(`FAILED — PR #${prNumber} closed without merging, branch deleted.`)
		} else {
			logger.error('FAILED — No PR was opened. No changes were made.')
		}
		logger.error(`Plan "${iterationPlan.title}" failed — starting fresh plan.`)
	}

	const allMessages = [...plannerMessages, ...session.conversation, ...(fixer?.conversation ?? [])]
	const reflection = await reflect(outcome, allMessages)
	await storeReflection(reflection)
	await writeIterationLog()

	return merged
}
