import { jest, describe, it, expect, beforeEach } from '@jest/globals'

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
		maxPlannerRounds: 25,
		maxBuilderRounds: 40,
		workspacePath: './workspace',
		db: { uri: '', maxRetryAttempts: 5, retryInterval: 5000 },
		memoryTokenBudget: 10000,
	},
}))

jest.unstable_mockModule('./database.js', () => ({
	connectToDatabase: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	disconnectFromDatabase: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./tools/git.js', () => ({
	cloneRepo: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	createBranch: jest.fn<() => Promise<string>>().mockResolvedValue('seedgpt/test-change'),
	commitAndPush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	getRecentLog: jest.fn<() => Promise<string>>().mockResolvedValue('abc1234 initial commit'),
	resetWorkspace: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./tools/github.js', () => ({
	openPR: jest.fn<() => Promise<number>>().mockResolvedValue(1),
	mergePR: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	closePR: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	deleteRemoteBranch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./tools/codebase.js', () => ({
	snapshotCodebase: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./memory.js', () => ({
	getContext: jest.fn<() => Promise<string>>().mockResolvedValue('No memories yet. This is your first run.'),
	getFailureSummary: jest.fn<() => Promise<string>>().mockResolvedValue(''),
	storePastMemory: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('./pipeline.js', () => ({
	cleanupStalePRs: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	awaitChecks: jest.fn<() => Promise<{ passed: boolean; error?: string }>>().mockResolvedValue({ passed: true }),
	getCoverage: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
}))

jest.unstable_mockModule('./usage.js', () => ({
	logSummary: jest.fn<() => void>(),
	saveUsageData: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
let mockExhausted = false
const mockPatchSession = {
	createPatch: jest.fn<() => Promise<typeof mockEdits>>().mockResolvedValue(mockEdits),
	fixPatch: jest.fn<(...args: unknown[]) => Promise<typeof mockEdits>>().mockResolvedValue(mockEdits),
	get exhausted() { return mockExhausted },
	conversation: [] as unknown[],
}

jest.unstable_mockModule('./plan.js', () => ({
	plan: jest.fn<() => Promise<{ plan: typeof mockPlan; messages: [] }>>().mockResolvedValue({ plan: mockPlan, messages: [] }),
}))

jest.unstable_mockModule('./reflect.js', () => ({
	reflect: jest.fn<() => Promise<string>>().mockResolvedValue('Test reflection.'),
}))

jest.unstable_mockModule('./build.js', () => ({
	PatchSession: jest.fn().mockImplementation(() => mockPatchSession),
}))

const { run } = await import('./loop.js')
const database = await import('./database.js')
const git = await import('./tools/git.js')
const github = await import('./tools/github.js')
const pipeline = await import('./pipeline.js')
const memory = await import('./memory.js')
const planModule = await import('./plan.js')
const reflectModule = await import('./reflect.js')
const buildModule = await import('./build.js')

beforeEach(() => {
	jest.clearAllMocks()
	mockExhausted = false
})

describe('run', () => {
	it('completes a successful iteration: plan → patch → PR → merge', async () => {
		await run()

		expect(database.connectToDatabase).toHaveBeenCalledTimes(1)
		expect(pipeline.cleanupStalePRs).toHaveBeenCalledTimes(1)
		expect(git.cloneRepo).toHaveBeenCalledTimes(1)
		expect(memory.getContext).toHaveBeenCalledTimes(1)
		expect(planModule.plan).toHaveBeenCalledTimes(1)
		expect(memory.storePastMemory).toHaveBeenCalledWith(expect.stringContaining('Planned change'))
		expect(git.createBranch).toHaveBeenCalledTimes(1)
		expect(git.commitAndPush).toHaveBeenCalledTimes(1)
		expect(github.openPR).toHaveBeenCalledTimes(1)
		expect(pipeline.awaitChecks).toHaveBeenCalledTimes(1)
		expect(github.mergePR).toHaveBeenCalledWith(1)
		expect(github.deleteRemoteBranch).toHaveBeenCalledWith('seedgpt/test-change')
		expect(memory.storePastMemory).toHaveBeenCalledWith(expect.stringContaining('Merged PR'))
		expect(pipeline.getCoverage).toHaveBeenCalledTimes(1)
		expect(database.disconnectFromDatabase).toHaveBeenCalledTimes(1)
	})

	it('stores coverage report in memory when available', async () => {
		const getCoverage = pipeline.getCoverage as jest.MockedFunction<typeof pipeline.getCoverage>
		getCoverage.mockResolvedValueOnce('Coverage: 80% statements, 70% branches')

		await run()

		expect(memory.storePastMemory).toHaveBeenCalledWith(expect.stringContaining('Post-merge coverage report'))
		expect(memory.storePastMemory).toHaveBeenCalledWith(expect.stringContaining('80% statements'))
	})

	it('skips coverage memory when no coverage data available', async () => {
		await run()

		const storeCalls = (memory.storePastMemory as jest.Mock).mock.calls.map(c => c[0] as string)
		expect(storeCalls.some(c => c.includes('coverage report'))).toBe(false)
	})

	it('retries with fixPatch on CI failure and merges', async () => {
		const awaitChecks = pipeline.awaitChecks as jest.MockedFunction<typeof pipeline.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'type error in index.ts' })
			.mockResolvedValueOnce({ passed: true })

		await run()

		expect(git.commitAndPush).toHaveBeenCalledTimes(2)
		expect(mockPatchSession.fixPatch).toHaveBeenCalledWith('type error in index.ts')
		expect(github.mergePR).toHaveBeenCalledWith(1)
	})

	it('closes PR when builder exhausts turns, then succeeds on next plan', async () => {
		const awaitChecks = pipeline.awaitChecks as jest.MockedFunction<typeof pipeline.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'persistent failure' })
			.mockResolvedValueOnce({ passed: true })

		mockExhausted = true

		await run()

		expect(mockPatchSession.fixPatch).not.toHaveBeenCalled()
		expect(github.closePR).toHaveBeenCalledWith(1)
		expect(github.deleteRemoteBranch).toHaveBeenCalledWith('seedgpt/test-change')
		expect(memory.storePastMemory).toHaveBeenCalledWith(expect.stringContaining('Closed PR'))
		expect(github.mergePR).toHaveBeenCalled()
	})

	it('handles empty edits without crashing then succeeds on next plan', async () => {
		mockPatchSession.createPatch.mockResolvedValueOnce([] as typeof mockEdits)

		const awaitChecks = pipeline.awaitChecks as jest.MockedFunction<typeof pipeline.awaitChecks>
		awaitChecks.mockResolvedValue({ passed: true })

		await run()

		expect(memory.storePastMemory).toHaveBeenCalledWith(expect.stringContaining('Gave up'))
		expect(github.mergePR).toHaveBeenCalled()
	})

	it('disconnects from database even on crash', async () => {
		const cloneRepo = git.cloneRepo as jest.MockedFunction<typeof git.cloneRepo>
		cloneRepo.mockRejectedValueOnce(new Error('network error'))

		await expect(run()).rejects.toThrow('network error')
		expect(database.disconnectFromDatabase).toHaveBeenCalledTimes(1)
	})
})
