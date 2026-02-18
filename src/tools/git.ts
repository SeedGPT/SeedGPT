import simpleGit, { SimpleGit } from 'simple-git'
import { writeFile, unlink, readFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { config } from '../config.js'
import { env } from '../env.js'
import logger from '../logger.js'
import type { EditOperation } from '../agents/build.js'

let client: SimpleGit

function getClient(): SimpleGit {
	if (!client) throw new Error('Git client not initialized — call cloneRepo() first')
	return client
}

export async function cloneRepo(): Promise<void> {
	const url = `https://x-access-token:${env.githubToken}@github.com/${env.githubOwner}/${env.githubRepo}.git`
	logger.info(`Cloning ${env.githubOwner}/${env.githubRepo}`)

	const git = simpleGit()
	await git.clone(url, env.workspacePath)

	client = simpleGit(env.workspacePath)
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
		const fullPath = join(env.workspacePath, op.filePath)

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

export async function getHeadSha(): Promise<string> {
	return (await getClient().revparse(['HEAD'])).trim()
}

export async function getRecentLog(count = config.git.recentLogCount): Promise<string> {
	const raw = await getClient().raw(['log', '--name-only', `--format=%h %s`, `-${count}`])
	return parseRecentLog(raw)
}

function parseRecentLog(raw: string): string {
	const entries: string[] = []
	let currentCommit: string | null = null
	let currentFiles: string[] = []

	function flush(): void {
		if (currentCommit === null) return
		if (currentFiles.length === 0) {
			entries.push(currentCommit)
		} else if (currentFiles.length > 5) {
			entries.push(`${currentCommit}\n  ${currentFiles.slice(0, 5).join(', ')} (+ ${currentFiles.length - 5} more)`)
		} else {
			entries.push(`${currentCommit}\n  ${currentFiles.join(', ')}`)
		}
		currentCommit = null
		currentFiles = []
	}

	for (const line of raw.split('\n')) {
		if (/^[0-9a-f]+ /.test(line)) {
			flush()
			currentCommit = line
		} else if (line.trim() !== '') {
			currentFiles.push(line.trim())
		}
	}
	flush()

	return entries.join('\n')
}

export async function resetWorkspace(): Promise<void> {
	const git = getClient()
	await git.checkout(['.'])
	await git.clean('f', ['-d'])
	await git.checkout('main')
	await git.pull()
}

export async function getDiff(): Promise<string> {
	const git = simpleGit(env.workspacePath)
	// `add -N` (intent-to-add) stages untracked files without content so they appear in the diff.
	// Without this, newly created files would be invisible to `git diff`.
	await git.raw(['add', '-N', '.'])
	const diff = await git.diff(['--stat', '-p', 'main'])
	if (!diff.trim()) return 'No changes compared to main.'
	return truncateDiff(diff)
}

function truncateDiff(diff: string): string {
	const chunks = diff.split(/(?=^diff --git )/m)
	const processed: string[] = []

	for (const chunk of chunks) {
		if (!chunk.startsWith('diff --git ')) {
			processed.push(chunk)
			continue
		}

		const isNewFile = /^new file mode/m.test(chunk)
		const isDeleted = /^deleted file mode/m.test(chunk)

		if (isNewFile || isDeleted) {
			const nameMatch = chunk.match(/^diff --git a\/.+ b\/(.+)$/m)
			const fileName = nameMatch?.[1] ?? 'unknown'
			const contentLines = chunk.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
				.filter(l => !l.startsWith('+++') && !l.startsWith('---'))
			const charCount = contentLines.reduce((s, l) => s + l.length - 1, 0)
			const label = isNewFile ? 'new file' : 'deleted file'
			processed.push(`diff --git a/${fileName} b/${fileName}\n  [${label}: ${fileName} — ${contentLines.length} lines, ${charCount} chars]\n`)
		} else {
			processed.push(chunk)
		}
	}

	const result = processed.join('')
	const lines = result.split('\n')
	if (lines.length > 500) {
		return lines.slice(0, 500).join('\n') + `\n\n(truncated — ${lines.length} total lines)`
	}
	return result
}
