import * as git from './tools/git.js'
import * as github from './tools/github.js'
import * as codebase from './tools/codebase.js'
import * as llm from './llm.js'
import * as pipeline from './pipeline.js'
import * as memory from './memory.js'
import { connectToDatabase, disconnectFromDatabase } from './database.js'
import { config } from './config.js'
import logger, { writeIterationLog } from './logger.js'
import { logSummary, saveIterationData } from './usage.js'

export async function run(): Promise<void> {
	logger.info('SeedGPT starting iteration...')

	await connectToDatabase()

	try {
		// Close any orphaned PRs from previous crashed iterations before starting
		await pipeline.cleanupStalePRs()

		const gitClient = await git.cloneRepo()

		let merged = false

		// The agent keeps generating new plans until one successfully merges.
		// This is intentional — a failed plan doesn't stop the agent; it reflects,
		// learns from the failure, and tries a different approach.
		while (!merged) {
			const recentMemory = await memory.getContext()
			const iterationHistory = await memory.getIterationHistory()
			const [fileTree, declarationIndex, depGraph] = await Promise.all([
				codebase.getFileTree(config.workspacePath),
				codebase.getDeclarationIndex(config.workspacePath),
				codebase.getDependencyGraph(config.workspacePath),
			])
			codebase.snapshotContext(fileTree, declarationIndex, depGraph)
			const codebaseContext = `## File Tree\n\`\`\`\n${fileTree}\n\`\`\`\n\n## Dependency Graph\n${depGraph}\n\n## Declarations\n${declarationIndex}`
			const gitLog = await git.getRecentLog(gitClient)

			const { plan, messages: plannerMessages } = await llm.plan(recentMemory, codebaseContext, gitLog, iterationHistory)
			await memory.store(`Planned change "${plan.title}": ${plan.description}`)

			const session = new llm.PatchSession(plan, recentMemory)
			let edits = await session.createPatch()

			const branchName = await git.createBranch(gitClient, plan.title)
			// The PR is created on the first successful commit, then subsequent fix attempts
			// push to the same branch/PR rather than creating new ones. This keeps the iteration
			// history in a single PR thread.
			let prNumber: number | null = null
			let lastError: string | null = null
			let outcome: string | null = null

			for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
				if (attempt > 0) {
					logger.warn(`Attempt ${attempt + 1}/${config.maxRetries + 1}: ${lastError?.slice(0, 200)}`)
					await memory.store(`Attempt ${attempt} failed for "${plan.title}"${prNumber ? ` (PR #${prNumber})` : ''}: ${lastError?.slice(0, 500)}`)
					edits = await session.fixPatch(lastError!)
				}

				if (edits.length === 0) {
					lastError = 'No edit operations were returned. The patch must contain at least one change.'
					continue
				}

				if (prNumber === null) {
					await git.commitAndPush(gitClient, plan.title)
					prNumber = await github.openPR(branchName, plan.title, plan.description)
				} else {
					await git.commitAndPush(gitClient, `fix: ${plan.title} (attempt ${attempt + 1})`)
				}

				const result = await pipeline.awaitChecks(gitClient)
				if (result.passed) {
					await github.mergePR(prNumber)
					await github.deleteRemoteBranch(branchName).catch(() => {})
					await memory.store(`Merged PR #${prNumber}: "${plan.title}" — CI passed and change is now on main.`)
					logger.info(`PR #${prNumber} merged.`)
					outcome = `PR #${prNumber} merged successfully after ${attempt + 1} attempt(s).`
					merged = true
					break
				}

				lastError = result.error ?? 'CI checks failed with unknown error'
			}

			// Always reset workspace to clean main, regardless of success or failure.
			// This ensures the next plan starts from a known-good state.
			await gitClient.checkout(['.'])
			await gitClient.clean('f', ['-d'])
			await gitClient.checkout('main')
			await gitClient.pull()

			if (!merged) {
				if (prNumber !== null) {
					await github.closePR(prNumber)
					await github.deleteRemoteBranch(branchName).catch(() => {})
					await memory.store(`Closed PR #${prNumber}: "${plan.title}" — failed after ${config.maxRetries + 1} attempts. Last error: ${lastError?.slice(0, 500)}`)
				} else {
					await memory.store(`Gave up on "${plan.title}" — could not produce a valid patch after ${config.maxRetries + 1} attempts. Last error: ${lastError?.slice(0, 500)}`)
				}
				outcome = `Failed after ${config.maxRetries + 1} attempts. Last error: ${lastError?.slice(0, 500)}`
				logger.error(`Failed after ${config.maxRetries + 1} attempts — starting fresh plan.`)
			}

			// logSummary must run before reflect so the reflection can see usage stats in the log buffer
			logSummary()
			const reflection = await llm.reflect(outcome!, plannerMessages, session.conversation)
			await memory.store(`Self-reflection: ${reflection}`)
			await saveIterationData(plan.title, outcome!, plannerMessages, session.conversation, reflection)
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		try {
			await memory.store(`Iteration crashed with error: ${message}`)
		} catch { /* Swallowed because the crash itself may have been caused by a DB failure */ }
		throw error
	} finally {
		await writeIterationLog()
		await disconnectFromDatabase()
	}
}
