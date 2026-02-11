import { cloneRepo, commitAndPush, createBranch, getRecentLog, resetWorkspace } from './tools/git.js'
import { closePR, deleteRemoteBranch, mergePR, openPR } from './tools/github.js'
import { snapshotCodebase } from './tools/codebase.js'
import { awaitChecks, cleanupStalePRs, getCoverage } from './pipeline.js'
import { config } from './config.js'
import { getContext, getFailureSummary, storePastMemory } from './memory.js'
import { connectToDatabase, disconnectFromDatabase } from './database.js'
import logger, { writeIterationLog } from './logger.js'
import { logSummary, saveUsageData } from './usage.js'
import { plan } from './plan.js'
import { PatchSession } from './build.js'
import { reflect } from './reflect.js'

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
		await writeIterationLog()
		await disconnectFromDatabase()
	}
}

async function iterate(): Promise<boolean> {
	await snapshotCodebase(config.workspacePath)
	const recentMemory = await getContext()
	const gitLog = await getRecentLog()
	const failureSummary = await getFailureSummary()
	const coverageData = await getCoverage()

	const { plan: iterationPlan, messages: plannerMessages } = await plan(recentMemory, gitLog, failureSummary, coverageData)
	await storePastMemory(`Planned change "${iterationPlan.title}": ${iterationPlan.description}`)

	const session = new PatchSession(iterationPlan, recentMemory)
	const branchName = await createBranch(iterationPlan.title)

	let edits = await session.createPatch()
	let prNumber: number | null = null
	let merged = false
	let outcome: string

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
				outcome = `CI failed: ${error.slice(0, 500)}`
				break
			}

			logger.warn(`CI failed, attempting fix: ${error.slice(0, 200)}`)
			await storePastMemory(`CI failed for "${iterationPlan.title}" (PR #${prNumber}): ${error.slice(0, 500)}`)

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

	await resetWorkspace()

	if (!merged) {
		if (prNumber !== null) {
			await closePR(prNumber)
			await deleteRemoteBranch(branchName).catch(() => {})
			await storePastMemory(`Closed PR #${prNumber}: "${iterationPlan.title}" — ${outcome}`)
		} else {
			await storePastMemory(`Gave up on "${iterationPlan.title}" — ${outcome}`)
		}
		logger.error(`Plan "${iterationPlan.title}" failed — starting fresh plan.`)
	}

	logSummary()
	const allMessages = [...plannerMessages, ...session.conversation]
	const reflection = await reflect(outcome, allMessages)
	await storePastMemory(`Self-reflection: ${reflection}`)
	await saveUsageData(iterationPlan.title)

	return merged
}
