import simpleGit, { SimpleGit } from 'simple-git'
import { writeFile, unlink, readFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { config } from '../config.js'
import logger from '../logger.js'
import type { EditOperation } from '../agents/build.js'

let client: SimpleGit

function getClient(): SimpleGit {
	if (!client) throw new Error('Git client not initialized — call cloneRepo() first')
	return client
}

export async function cloneRepo(): Promise<void> {
	const url = `https://x-access-token:${config.githubToken}@github.com/${config.githubOwner}/${config.githubRepo}.git`
	logger.info(`Cloning ${config.githubOwner}/${config.githubRepo}`)

	const git = simpleGit()
	await git.clone(url, config.workspacePath)

	client = simpleGit(config.workspacePath)
	await client.addConfig('user.email', 'agent.seedgpt@gmail.com')
	await client.addConfig('user.name', 'SeedGPT')
}

export async function createBranch(name: string): Promise<string> {
	const git = getClient()
	const branchName = 'seedgpt/' + name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-/]/g, '').slice(0, 60)
	logger.info(`Creating branch: ${branchName}`)
	await git.checkoutLocalBranch(branchName)
	return branchName
}

export async function applyEdits(operations: EditOperation[]): Promise<void> {
	const errors: string[] = []

	for (const op of operations) {
		const fullPath = join(config.workspacePath, op.filePath)

		try {
			if (op.type === 'replace') {
				const content = await readFile(fullPath, 'utf-8')
				// Validates exact single-match to prevent ambiguous edits. The LLM sometimes
				// provides too little context in oldString, which could match multiple locations
				// and silently corrupt the wrong part of a file.
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

export async function commitAndPush(message: string, force = false): Promise<void> {
	const git = getClient()
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

export async function resetToMain(): Promise<void> {
	const git = getClient()
	await git.raw(['reset', '--hard', 'origin/main'])
	logger.info('Reset branch to origin/main')
}

export async function getHeadSha(): Promise<string> {
	return (await getClient().revparse(['HEAD'])).trim()
}

export async function getRecentLog(count = 10): Promise<string> {
	const log = await getClient().log({ maxCount: count })
	return log.all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join('\n')
}

export async function resetWorkspace(): Promise<void> {
	const git = getClient()
	await git.checkout(['.'])
	await git.clean('f', ['-d'])
	await git.checkout('main')
	await git.pull()
}

export async function getDiff(): Promise<string> {
	const git = simpleGit(config.workspacePath)
	// `add -N` (intent-to-add) stages untracked files without content so they appear in the diff.
	// Without this, newly created files would be invisible to `git diff`.
	await git.raw(['add', '-N', '.'])
	const diff = await git.diff(['--stat', '-p', 'main'])
	if (!diff.trim()) return 'No changes compared to main.'
	return abbreviateDiff(diff)
}

function abbreviateDiff(diff: string): string {
	const lines = diff.split('\n')
	const result: string[] = []
	let i = 0
	
	while (i < lines.length) {
		const line = lines[i]
		
		// Check if this is a file header
		if (line.startsWith('diff --git ')) {
			// Capture the file header
			result.push(line)
			i++
			
			// Look ahead to determine file type (created, deleted, or modified)
			let isCreated = false
			let isDeleted = false
			let filePath = ''
			
			// Parse the next few lines to identify the file operation
			while (i < lines.length && !lines[i].startsWith('diff --git ')) {
				const currentLine = lines[i]
				
				// Detect file path and type
				if (currentLine.startsWith('--- ')) {
					if (currentLine.includes('/dev/null')) {
						isCreated = true
					} else {
						filePath = currentLine.substring(4).replace(/^a\//, '')
					}
					result.push(currentLine)
					i++
				} else if (currentLine.startsWith('+++ ')) {
					if (currentLine.includes('/dev/null')) {
						isDeleted = true
					} else {
						filePath = currentLine.substring(4).replace(/^b\//, '')
					}
					result.push(currentLine)
					i++
					break
				} else {
					result.push(currentLine)
					i++
				}
			}
			
			// Process the file content based on type
			if (isCreated) {
				// For created files, count lines and skip content
				let lineCount = 0
				while (i < lines.length && !lines[i].startsWith('diff --git ')) {
					if (lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
						lineCount++
					}
					i++
				}
				result.push(`Created: ${filePath} (${lineCount} lines)`)
				result.push('') // Empty line for readability
			} else if (isDeleted) {
				// For deleted files, skip content
				while (i < lines.length && !lines[i].startsWith('diff --git ')) {
					i++
				}
				result.push(`Deleted: ${filePath}`)
				result.push('') // Empty line for readability
			} else {
				// For modified files, preserve full diff content
				while (i < lines.length && !lines[i].startsWith('diff --git ')) {
					result.push(lines[i])
					i++
				}
			}
		} else {
			// Preserve non-diff lines (like stat summary at the end)
			result.push(line)
			i++
		}
	}
	
	const output = result.join('\n')
	
	// Apply truncation as a safety measure for extremely large diffs
	const outputLines = output.split('\n')
	if (outputLines.length > 500) {
		return outputLines.slice(0, 500).join('\n') + `\n\n(truncated — ${outputLines.length} total lines)`
	}
	
	return output
}
