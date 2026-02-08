import simpleGit, { SimpleGit } from 'simple-git'
import { writeFile, unlink, readFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { config } from '../config.js'
import logger from '../logger.js'
import type { EditOperation } from '../llm.js'

export async function cloneRepo(): Promise<SimpleGit> {
	const url = `https://x-access-token:${config.githubToken}@github.com/${config.githubOwner}/${config.githubRepo}.git`
	logger.info(`Cloning ${config.githubOwner}/${config.githubRepo}`)

	const git = simpleGit()
	await git.clone(url, config.workspacePath)

	const workspace = simpleGit(config.workspacePath)
	await workspace.addConfig('user.email', 'agent.seedgpt@gmail.com')
	await workspace.addConfig('user.name', 'SeedGPT')
	return workspace
}

export async function createBranch(git: SimpleGit, name: string): Promise<string> {
	const branchName = 'seedgpt/' + name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-/]/g, '').slice(0, 60)
	logger.info(`Creating branch: ${branchName}`)
	await git.checkoutLocalBranch(branchName)
	return branchName
}

function validateOperations(operations: EditOperation[]): string[] {
	const errors: string[] = []

	for (let i = 0; i < operations.length; i++) {
		const op = operations[i]
		const label = `operations[${i}] (${op.type})`

		if (!op.filePath || op.filePath.trim() === '') {
			errors.push(`${label}: filePath is required and must be non-empty`)
		}

		if (op.type === 'replace') {
			if (op.oldString === undefined || op.oldString === null) {
				errors.push(`${label}: oldString is required for replace operations`)
			}
			if (op.newString === undefined || op.newString === null) {
				errors.push(`${label}: newString is required for replace operations`)
			}
		} else if (op.type === 'create') {
			if ((op as any).content === undefined || (op as any).content === null) {
				errors.push(`${label}: content is required for create operations`)
			}
		}
	}

	return errors
}

export async function applyEdits(operations: EditOperation[]): Promise<void> {
	const validationErrors = validateOperations(operations)
	if (validationErrors.length > 0) {
		throw new Error(`Edit operation validation failed:\n${validationErrors.join('\n')}`)
	}

	const errors: string[] = []

	for (const op of operations) {
		const fullPath = join(config.workspacePath, op.filePath)

		try {
			if (op.type === 'replace') {
				const content = await readFile(fullPath, 'utf-8')
				const index = content.indexOf(op.oldString)
				if (index === -1) {
					errors.push(`replace "${op.filePath}": oldString not found in file`)
					continue
				}
				const secondIndex = content.indexOf(op.oldString, index + 1)
				if (secondIndex !== -1) {
					errors.push(`replace "${op.filePath}": oldString matches multiple locations — add more context to make it unique`)
					continue
				}
				const updated = content.slice(0, index) + op.newString + content.slice(index + op.oldString.length)
				await writeFile(fullPath, updated, 'utf-8')
				logger.debug(`Replaced text in ${op.filePath}`)
			} else if (op.type === 'create') {
				await mkdir(dirname(fullPath), { recursive: true })
				await writeFile(fullPath, op.content, 'utf-8')
				logger.debug(`Created ${op.filePath}`)
			} else if (op.type === 'delete') {
				await unlink(fullPath)
				logger.debug(`Deleted ${op.filePath}`)
			}
		} catch (err) {
			errors.push(`${op.type} "${op.filePath}": ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	if (errors.length > 0) {
		throw new Error(`Edit operations failed:\n${errors.join('\n')}`)
	}

	logger.info(`Applied ${operations.length} edit(s) successfully`)
}

export async function commitAndPush(git: SimpleGit, message: string, force = false): Promise<void> {
	await git.add('.')
	await git.commit(message)
	const branch = (await git.branch()).current

	if (force) {
		await git.raw(['push', '--force', 'origin', branch])
	} else {
		await git.push('origin', branch)
	}

	logger.info(`Committed and pushed to ${branch}${force ? ' (force)' : ''}`)
}

export async function resetToMain(git: SimpleGit): Promise<void> {
	await git.raw(['reset', '--hard', 'origin/main'])
	logger.info('Reset branch to origin/main')
}

export async function getHeadSha(git: SimpleGit): Promise<string> {
	return (await git.revparse(['HEAD'])).trim()
}

export async function getRecentLog(git: SimpleGit, count = 10): Promise<string> {
	const log = await git.log({ maxCount: count })
	return log.all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join('\n')
}
