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
import { computeCost } from './models/Generated.js'

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
	let plannerMessages: any[]
	let session: PatchSession
	let iterationPlan: any
	let branchName: string

	// Token usage tracking
	const tokenUsage = {
		planner: { input: 0, output: 0, cost: 0 },
		builder: { input: 0, output: 0, cost: 0 },
		reflect: { input: 0, output: 0, cost: 0 },
		total: { input: 0, output: 0, cost: 0 }
	}

	try {
		await snapshotCodebase(config.workspacePath)
		const recentMemory = await getContext()
		const gitLog = await getRecentLog()

		const planResult = await plan(recentMemory, gitLog)
		iterationPlan = planResult.plan
		plannerMessages = planResult.messages
		tokenUsage.planner.input = planResult.tokenUsage.input
		tokenUsage.planner.output = planResult.tokenUsage.output
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
		if (prNumber !== null) {
			await closePR(prNumber)
			await deleteRemoteBranch(branchName).catch(() => {})
			await storePastMemory(`Closed PR #${prNumber}: "${iterationPlan.title}" — ${outcome}`)
		} else {
			await storePastMemory(`Gave up on "${iterationPlan.title}" — ${outcome}`)
		}
		logger.error(`Plan "${iterationPlan.title}" failed — starting fresh plan.`)
	}

	const allMessages = [...plannerMessages, ...session.conversation]
	const reflectResult = await reflect(outcome, allMessages)
	const reflection = reflectResult.reflection
	tokenUsage.reflect.input = reflectResult.tokenUsage.input
	tokenUsage.reflect.output = reflectResult.tokenUsage.output
	
	// Get builder token usage
	const builderUsage = session.getTokenUsage()
	tokenUsage.builder.input = builderUsage.input
	tokenUsage.builder.output = builderUsage.output
	
	// Compute costs and totals
	tokenUsage.planner.cost = computeCost(tokenUsage.planner.input, tokenUsage.planner.output)
	tokenUsage.builder.cost = computeCost(tokenUsage.builder.input, tokenUsage.builder.output)
	tokenUsage.reflect.cost = computeCost(tokenUsage.reflect.input, tokenUsage.reflect.output)
	tokenUsage.total.input = tokenUsage.planner.input + tokenUsage.builder.input + tokenUsage.reflect.input
	tokenUsage.total.output = tokenUsage.planner.output + tokenUsage.builder.output + tokenUsage.reflect.output
	tokenUsage.total.cost = tokenUsage.planner.cost + tokenUsage.builder.cost + tokenUsage.reflect.cost
	
	await storePastMemory(`Self-reflection: ${reflection}`)
	await writeIterationLog(tokenUsage)
	
	// Log token usage summary
	logger.info(
		`Iteration complete — Planner: ${tokenUsage.planner.input} input + ${tokenUsage.planner.output} output tokens ($${tokenUsage.planner.cost.toFixed(4)}), ` +
		`Builder: ${tokenUsage.builder.input} input + ${tokenUsage.builder.output} output tokens ($${tokenUsage.builder.cost.toFixed(4)}), ` +
		`Reflect: ${tokenUsage.reflect.input} input + ${tokenUsage.reflect.output} output tokens ($${tokenUsage.reflect.cost.toFixed(4)}), ` +
		`Total: ${tokenUsage.total.input + tokenUsage.total.output} tokens ($${tokenUsage.total.cost.toFixed(4)})`
	)

	return merged
}
