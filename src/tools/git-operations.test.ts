import { jest, describe, it, expect, beforeEach } from '@jest/globals'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		git: { recentLogCount: 10 },
	},
}))

jest.unstable_mockModule('../env.js', () => ({
	env: {
		workspacePath: '/test/workspace',
		githubToken: 'fake-token',
		githubOwner: 'test-owner',
		githubRepo: 'test-repo',
	},
}))

jest.unstable_mockModule('../logger.js', () => ({
	default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockGitClient = {
	clone: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	addConfig: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	checkoutLocalBranch: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	add: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	commit: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	push: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	raw: jest.fn<(...a: unknown[]) => Promise<string>>().mockResolvedValue('' as never),
	branch: jest.fn<(...a: unknown[]) => Promise<{ current: string }>>().mockResolvedValue({ current: 'seedgpt/test' } as never),
	revparse: jest.fn<(...a: unknown[]) => Promise<string>>().mockResolvedValue('abc1234567\n' as never),
	log: jest.fn<(...a: unknown[]) => Promise<{ all: Array<{ hash: string; message: string }> }>>().mockResolvedValue({
		all: [{ hash: 'abc1234567', message: 'test commit' }],
	} as never),
	checkout: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	clean: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	pull: jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined as never),
	diff: jest.fn<(...a: unknown[]) => Promise<string>>().mockResolvedValue('' as never),
}

jest.unstable_mockModule('simple-git', () => ({
	default: jest.fn(() => mockGitClient),
}))

const git = await import('./git.js')

beforeEach(() => {
	jest.clearAllMocks()
})

describe('cloneRepo', () => {
	it('clones the repo and configures git identity', async () => {
		await git.cloneRepo()
		expect(mockGitClient.clone).toHaveBeenCalled()
		expect(mockGitClient.addConfig).toHaveBeenCalledWith('user.email', 'agent.seedgpt@gmail.com')
		expect(mockGitClient.addConfig).toHaveBeenCalledWith('user.name', 'SeedGPT')
	})
})

describe('createBranch', () => {
	it('creates a branch with seedgpt/ prefix', async () => {
		await git.cloneRepo()
		const branch = await git.createBranch('Add Input Validation')
		expect(branch).toBe('seedgpt/add-input-validation')
		expect(mockGitClient.checkoutLocalBranch).toHaveBeenCalledWith('seedgpt/add-input-validation')
	})

	it('strips invalid characters from branch name', async () => {
		await git.cloneRepo()
		const branch = await git.createBranch('Fix Bug #123 @important!')
		expect(branch).toBe('seedgpt/fix-bug-123-important')
	})

	it('truncates branch name to 60 characters', async () => {
		await git.cloneRepo()
		const longName = 'a-very-long-feature-name-that-exceeds-the-sixty-character-limit-by-quite-a-lot'
		const branch = await git.createBranch(longName)
		const afterPrefix = branch.slice('seedgpt/'.length)
		expect(afterPrefix.length).toBeLessThanOrEqual(60)
		expect(afterPrefix.length).toBeGreaterThan(30)
	})
})

describe('commitAndPush', () => {
	it('adds all files, commits, and pushes', async () => {
		await git.cloneRepo()
		await git.commitAndPush('test commit')
		expect(mockGitClient.add).toHaveBeenCalledWith('.')
		expect(mockGitClient.commit).toHaveBeenCalledWith('test commit')
		expect(mockGitClient.push).toHaveBeenCalledWith('origin', 'seedgpt/test')
	})

	it('force pushes when force flag is set', async () => {
		await git.cloneRepo()
		await git.commitAndPush('force commit', true)
		expect(mockGitClient.raw).toHaveBeenCalledWith(['push', '--force', 'origin', 'seedgpt/test'])
	})
})

describe('getHeadSha', () => {
	it('returns trimmed HEAD sha', async () => {
		await git.cloneRepo()
		const sha = await git.getHeadSha()
		expect(sha).toBe('abc1234567')
	})
})

describe('getRecentLog', () => {
	it('returns formatted log entries with file names', async () => {
		await git.cloneRepo()
		mockGitClient.raw.mockResolvedValueOnce('abc1234 test commit\n\nfoo.ts\nbar.ts\n' as never)
		const log = await git.getRecentLog()
		expect(log).toBe('abc1234 test commit\n  foo.ts, bar.ts')
	})

	it('truncates file list when commit touches more than 5 files', async () => {
		await git.cloneRepo()
		mockGitClient.raw.mockResolvedValueOnce('abc1234 test commit\n\nfile1.ts\nfile2.ts\nfile3.ts\nfile4.ts\nfile5.ts\nfile6.ts\nfile7.ts\n' as never)
		const log = await git.getRecentLog()
		expect(log).toBe('abc1234 test commit\n  file1.ts, file2.ts, file3.ts, file4.ts, file5.ts (+ 2 more)')
	})
})

describe('resetWorkspace', () => {
	it('checks out main, cleans, and pulls', async () => {
		await git.cloneRepo()
		await git.resetWorkspace()
		expect(mockGitClient.checkout).toHaveBeenCalledWith(['.'])
		expect(mockGitClient.clean).toHaveBeenCalledWith('f', ['-d'])
		expect(mockGitClient.checkout).toHaveBeenCalledWith('main')
		expect(mockGitClient.pull).toHaveBeenCalled()
	})
})

describe('getDiff', () => {
	it('returns no-change message for empty diff', async () => {
		mockGitClient.diff.mockResolvedValue('' as never)
		const result = await git.getDiff()
		expect(result).toBe('No changes compared to main.')
	})

	it('stages untracked files with add -N', async () => {
		mockGitClient.diff.mockResolvedValue('diff --git a/f.ts b/f.ts\n+line' as never)
		await git.getDiff()
		expect(mockGitClient.raw).toHaveBeenCalledWith(['add', '-N', '.'])
	})

	it('summarizes new files instead of showing full content', async () => {
		const newFileDiff = [
			'diff --git a/new.ts b/new.ts',
			'new file mode 100644',
			'--- /dev/null',
			'+++ b/new.ts',
			'+export const x = 1',
			'+export const y = 2',
		].join('\n')
		mockGitClient.diff.mockResolvedValue(newFileDiff as never)

		const result = await git.getDiff()
		expect(result).toContain('[new file: new.ts')
		expect(result).toContain('2 lines')
	})

	it('summarizes deleted files', async () => {
		const deletedDiff = [
			'diff --git a/old.ts b/old.ts',
			'deleted file mode 100644',
			'--- a/old.ts',
			'+++ /dev/null',
			'-const x = 1',
			'-const y = 2',
			'-const z = 3',
		].join('\n')
		mockGitClient.diff.mockResolvedValue(deletedDiff as never)

		const result = await git.getDiff()
		expect(result).toContain('[deleted file: old.ts')
		expect(result).toContain('3 lines')
	})

	it('keeps modified file diffs as-is', async () => {
		const modifiedDiff = [
			'diff --git a/existing.ts b/existing.ts',
			'--- a/existing.ts',
			'+++ b/existing.ts',
			'@@ -1,3 +1,3 @@',
			'-const x = 1',
			'+const x = 2',
			' const y = 3',
		].join('\n')
		mockGitClient.diff.mockResolvedValue(modifiedDiff as never)

		const result = await git.getDiff()
		expect(result).toContain('-const x = 1')
		expect(result).toContain('+const x = 2')
	})

	it('truncates diffs exceeding 500 lines', async () => {
		const longDiff = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
		mockGitClient.diff.mockResolvedValue(longDiff as never)

		const result = await git.getDiff()
		expect(result).toContain('truncated')
		expect(result).toContain('total lines')
	})
})
