import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type { SimpleGit } from 'simple-git'

jest.unstable_mockModule('./config.js', () => ({
	config: {
		env: 'test',
		isProduction: false,
		anthropicApiKey: 'test-key',
		githubToken: 'test-token',
		githubOwner: 'test-owner',
		githubRepo: 'test-repo',
		planModel: 'claude-haiku-4-5',
		patchModel: 'claude-haiku-4-5',
		maxRetries: 3,
		workspacePath: './workspace',
		db: { uri: '', maxRetryAttempts: 5, retryInterval: 5000 },
		memoryTokenBudget: 10000,
	},
}))

const mockGitClient = {
	checkout: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	clean: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	pull: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
} as unknown as SimpleGit

jest.unstable_mockModule('./database.js', () => ({
	connectToDatabase: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	disconnectFromDatabase: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./tools/git.js', () => ({
	cloneRepo: jest.fn<() => Promise<SimpleGit>>().mockResolvedValue(mockGitClient),
	createBranch: jest.fn<() => Promise<string>>().mockResolvedValue('seedgpt/test-change'),
	commitAndPush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	getRecentLog: jest.fn<() => Promise<string>>().mockResolvedValue('abc1234 initial commit'),
}))

jest.unstable_mockModule('./tools/github.js', () => ({
	openPR: jest.fn<() => Promise<number>>().mockResolvedValue(1),
	mergePR: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	closePR: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	deleteRemoteBranch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./tools/codebase.js', () => ({
	getFileTree: jest.fn<() => Promise<string>>().mockResolvedValue('.\n└── src/\n    └── index.ts'),
	getDeclarationIndex: jest.fn<() => Promise<string>>().mockResolvedValue('### src/index.ts (5 lines)\n  export function main(): void  [L1-5]'),
	getDependencyGraph: jest.fn<() => Promise<string>>().mockResolvedValue('No dependencies found.'),
	snapshotContext: jest.fn(),
}))

jest.unstable_mockModule('./memory.js', () => ({
	getContext: jest.fn<() => Promise<string>>().mockResolvedValue('No memories yet. This is your first run.'),
	getIterationHistory: jest.fn<() => Promise<string>>().mockResolvedValue(''),
	store: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./pipeline.js', () => ({
	cleanupStalePRs: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	awaitChecks: jest.fn<() => Promise<{ passed: boolean; error?: string }>>().mockResolvedValue({ passed: true }),
}))

jest.unstable_mockModule('./usage.js', () => ({
	logSummary: jest.fn<() => void>(),
	saveIterationData: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./logger.js', () => {
	const noop = () => {}
	return {
		default: { debug: noop, info: noop, warn: noop, error: noop },
		writeIterationLog: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	}
})

const mockPlan = { title: 'test-change', description: 'A test change', implementation: 'test implementation' }
const mockEdits = [{ type: 'replace' as const, filePath: 'src/index.ts', oldString: 'hello', newString: 'world' }]
const mockPatchSession = {
	createPatch: jest.fn<() => Promise<typeof mockEdits>>().mockResolvedValue(mockEdits),
	fixPatch: jest.fn<(...args: unknown[]) => Promise<typeof mockEdits>>().mockResolvedValue(mockEdits),
	conversation: [] as unknown[],
}

jest.unstable_mockModule('./llm.js', () => ({
	plan: jest.fn<() => Promise<{ plan: typeof mockPlan; messages: [] }>>().mockResolvedValue({ plan: mockPlan, messages: [] }),
	reflect: jest.fn<() => Promise<string>>().mockResolvedValue('Test reflection.'),
	PatchSession: jest.fn().mockImplementation(() => mockPatchSession),
}))

const { run } = await import('./loop.js')
const database = await import('./database.js')
const git = await import('./tools/git.js')
const github = await import('./tools/github.js')
const pipeline = await import('./pipeline.js')
const memory = await import('./memory.js')
const llm = await import('./llm.js')

beforeEach(() => { jest.clearAllMocks() })

describe('run', () => {
	it('completes a successful iteration: plan → patch → PR → merge', async () => {
		await run()

		expect(database.connectToDatabase).toHaveBeenCalledTimes(1)
		expect(pipeline.cleanupStalePRs).toHaveBeenCalledTimes(1)
		expect(git.cloneRepo).toHaveBeenCalledTimes(1)
		expect(memory.getContext).toHaveBeenCalledTimes(1)
		expect(llm.plan).toHaveBeenCalledTimes(1)
		expect(memory.store).toHaveBeenCalledWith(expect.stringContaining('Planned change'))
		expect(git.createBranch).toHaveBeenCalledTimes(1)
		expect(git.commitAndPush).toHaveBeenCalledTimes(1)
		expect(github.openPR).toHaveBeenCalledTimes(1)
		expect(pipeline.awaitChecks).toHaveBeenCalledTimes(1)
		expect(github.mergePR).toHaveBeenCalledWith(1)
		expect(github.deleteRemoteBranch).toHaveBeenCalledWith('seedgpt/test-change')
		expect(memory.store).toHaveBeenCalledWith(expect.stringContaining('Merged PR'))
		expect(database.disconnectFromDatabase).toHaveBeenCalledTimes(1)
	})

	it('retries and merges after a CI failure', async () => {
		const awaitChecks = pipeline.awaitChecks as jest.MockedFunction<typeof pipeline.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'type error in index.ts' })
			.mockResolvedValueOnce({ passed: true })

		await run()

		expect(git.commitAndPush).toHaveBeenCalledTimes(2)
		expect(mockPatchSession.fixPatch).toHaveBeenCalledWith('type error in index.ts')
		expect(github.mergePR).toHaveBeenCalledWith(1)
	})

	it('closes the PR after exhausting all retries then succeeds on next plan', async () => {
		const awaitChecks = pipeline.awaitChecks as jest.MockedFunction<typeof pipeline.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'persistent failure' })
			.mockResolvedValueOnce({ passed: false, error: 'persistent failure' })
			.mockResolvedValueOnce({ passed: false, error: 'persistent failure' })
			.mockResolvedValueOnce({ passed: false, error: 'persistent failure' })
			.mockResolvedValueOnce({ passed: true })

		await run()

		expect(github.closePR).toHaveBeenCalledWith(1)
		expect(github.deleteRemoteBranch).toHaveBeenCalledWith('seedgpt/test-change')
		expect(memory.store).toHaveBeenCalledWith(expect.stringContaining('Closed PR'))
		expect(github.mergePR).toHaveBeenCalled()
	})

	it('handles empty edits without crashing', async () => {
		mockPatchSession.createPatch.mockResolvedValueOnce([] as typeof mockEdits)
		mockPatchSession.fixPatch.mockResolvedValue(mockEdits as typeof mockEdits)

		const awaitChecks = pipeline.awaitChecks as jest.MockedFunction<typeof pipeline.awaitChecks>
		awaitChecks.mockResolvedValue({ passed: true })

		await run()

		expect(mockPatchSession.fixPatch).toHaveBeenCalled()
		expect(github.mergePR).toHaveBeenCalled()
	})

	it('disconnects from database even on crash', async () => {
		const cloneRepo = git.cloneRepo as jest.MockedFunction<typeof git.cloneRepo>
		cloneRepo.mockRejectedValueOnce(new Error('network error'))

		await expect(run()).rejects.toThrow('network error')
		expect(database.disconnectFromDatabase).toHaveBeenCalledTimes(1)
	})
})
