import { cloneRepo, commitAndPush, createBranch, getRecentLog, resetWorkspace } from './tools/git.js'
import { closePR, deleteRemoteBranch, mergePR, openPR } from './tools/github.js'
import { snapshotCodebase } from './tools/codebase.js'
import { awaitChecks, cleanupStalePRs, getCoverage } from './pipeline.js'
import { config } from './config.js'
import { getContext, storePastMemory } from './agents/memory.js'
import { connectToDatabase, disconnectFromDatabase } from './database.js'
import logger, { writeIterationLog } from './logger.js'
import { plan } from './agents/plan.js'
import { PatchSession } from './agents/build.js'
import { reflect } from './agents/reflect.js'

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
			await storePastMemory(`Iteration crashed with error: ${message}`)
		} catch { /* Swallowed because the crash itself may have been caused by a DB failure */ }
		throw error
	} finally {
		await disconnectFromDatabase()
	}
}

async function iterate(): Promise<boolean> {
	let merged = false
	let prNumber: number | null = null
	let outcome: string
	let plannerMessages: any[] = []
	let session: PatchSession | null = null
	let iterationPlan: any = null
	let branchName: string

	try {
		await snapshotCodebase(config.workspacePath)
		const recentMemory = await getContext()
		const gitLog = await getRecentLog()

		const planResult = await plan(recentMemory, gitLog)
		iterationPlan = planResult.plan
		plannerMessages = planResult.messages
		await storePastMemory(`Planned change "${iterationPlan.title}": ${iterationPlan.description}`)

		session = new PatchSession(iterationPlan, recentMemory)
		branchName = await createBranch(iterationPlan.title)

		let edits = await session.createPatch()

		if (edits.length === 0) {
			outcome = 'Builder produced no edits.'
		} else {
			await commitAndPush(iterationPlan.title)
			prNumber = await openPR(branchName, iterationPlan.title, iterationPlan.description)

			while (true) {
				const result = await awaitChecks()
				if (result.passed) {
					merged = true
					outcome = `PR #${prNumber} merged successfully.`
					break
				}

				const error = result.error ?? 'CI checks failed with unknown error'
				if (session.exhausted) {
					outcome = `CI failed: ${error.slice(0, 10000)}`
					break
				}

				logger.warn(`CI failed, attempting fix: ${error.slice(0, 200)}`)
				await storePastMemory(`CI failed for "${iterationPlan.title}" (PR #${prNumber}): ${error.slice(0, 10000)}`)

				try {
					edits = await session.fixPatch(error)
				} catch {
					outcome = `Builder failed to fix: ${error.slice(0, 500)}`
					break
				}

				if (edits.length === 0) {
					outcome = 'Builder produced no fix edits.'
					break
				}

				await commitAndPush(`fix: ${iterationPlan.title}`)
			}
		}

		if (merged) {
			await mergePR(prNumber!)
			await deleteRemoteBranch(branchName).catch(() => {})
			await storePastMemory(`Merged PR #${prNumber}: "${iterationPlan.title}" — CI passed and change is now on main.`)
			logger.info(`PR #${prNumber} merged.`)

			const coverage = await getCoverage()
			if (coverage) {
				await storePastMemory(`Post-merge coverage report:\n${coverage}`)
				logger.info('Stored coverage report in memory')
			}
		}
	} finally {
		await resetWorkspace()
	}

	if (!merged) {
		const planTitle = iterationPlan?.title ?? '(early failure)'
		if (prNumber !== null) {
			await closePR(prNumber)
			await deleteRemoteBranch(branchName).catch(() => {})
			await storePastMemory(`Closed PR #${prNumber}: "${planTitle}" — ${outcome}`)
		} else {
			await storePastMemory(`Gave up on "${planTitle}" — ${outcome}`)
		}
		logger.error(`Plan "${planTitle}" failed — starting fresh plan.`)
	}

	const allMessages = [...plannerMessages, ...(session?.conversation ?? [])]
	const reflection = await reflect(outcome, allMessages)
	await storePastMemory(`Self-reflection: ${reflection}`)
	await writeIterationLog()

	return merged
}
