import { jest, describe, it, expect, beforeEach } from '@jest/globals'

jest.unstable_mockModule('./config.js', () => ({
	config: {
		turns: {
			maxPlanner: 25,
			maxBuilder: 40,
			maxFixer: 20,
		},
		errors: {
			maxLoopErrorChars: 10000,
		},
		db: { maxRetryAttempts: 5, retryInterval: 5000 },
		memory: {
			tokenBudget: 10000,
			fullReflections: 5,
			summarizedReflections: 20,
			estimationRatio: 4,
		},
	},
}))

jest.unstable_mockModule('./env.js', () => ({
	env: {
		nodeEnv: 'test',
		isProduction: false,
		anthropicApiKey: 'test-key',
		githubToken: 'test-token',
		githubOwner: 'test-owner',
		githubRepo: 'test-repo',
		workspacePath: './workspace',
		db: { uri: '' },
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
	cleanupStalePRs: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	awaitChecks: jest.fn<() => Promise<{ passed: boolean; error?: string }>>().mockResolvedValue({ passed: true }),
	getLatestMainCoverage: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
}))

jest.unstable_mockModule('./tools/codebase.js', () => ({
	getCodebaseContext: jest.fn<() => Promise<string>>().mockResolvedValue('codebase context'),
	findUnusedFunctions: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
}))

jest.unstable_mockModule('./agents/memory.js', () => ({
	getMemoryContext: jest.fn<() => Promise<string>>().mockResolvedValue('No memories yet.'),
	storeReflection: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
	get exhausted() { return mockExhausted },
	conversation: [] as unknown[],
	editedFiles: { created: ['src/index.test.ts'], modified: ['src/index.ts'] },
}

let mockFixerExhausted = false
const mockFixSession = {
	fix: jest.fn<(...args: unknown[]) => Promise<typeof mockEdits>>().mockResolvedValue(mockEdits),
	get exhausted() { return mockFixerExhausted },
	conversation: [] as unknown[],
}

jest.unstable_mockModule('./agents/plan.js', () => ({
	plan: jest.fn<() => Promise<{ plan: typeof mockPlan; messages: [] }>>().mockResolvedValue({ plan: mockPlan, messages: [] }),
}))

jest.unstable_mockModule('./agents/reflect.js', () => ({
	reflect: jest.fn<() => Promise<string>>().mockResolvedValue('Test reflection.'),
}))

jest.unstable_mockModule('./agents/build.js', () => ({
	PatchSession: jest.fn().mockImplementation(() => mockPatchSession),
}))

jest.unstable_mockModule('./agents/fix.js', () => ({
	FixSession: jest.fn().mockImplementation(() => mockFixSession),
}))

const { run } = await import('./loop.js')
const database = await import('./database.js')
const git = await import('./tools/git.js')
const github = await import('./tools/github.js')
const memory = await import('./agents/memory.js')
const planModule = await import('./agents/plan.js')
const reflectModule = await import('./agents/reflect.js')
const buildModule = await import('./agents/build.js')
const fixModule = await import('./agents/fix.js')

beforeEach(() => {
	jest.clearAllMocks()
	mockExhausted = false
	mockFixerExhausted = false
})

describe('run', () => {
	it('completes a successful iteration: plan → patch → PR → merge', async () => {
		await run()

		expect(database.connectToDatabase).toHaveBeenCalledTimes(1)
		expect(github.cleanupStalePRs).toHaveBeenCalledTimes(1)
		expect(git.cloneRepo).toHaveBeenCalledTimes(1)
		expect(planModule.plan).toHaveBeenCalledTimes(1)
		expect(git.createBranch).toHaveBeenCalledTimes(1)
		expect(git.commitAndPush).toHaveBeenCalledTimes(1)
		expect(github.openPR).toHaveBeenCalledTimes(1)
		expect(github.awaitChecks).toHaveBeenCalledTimes(1)
		expect(github.mergePR).toHaveBeenCalledWith(1)
		expect(github.deleteRemoteBranch).toHaveBeenCalledWith('seedgpt/test-change')
		expect(memory.storeReflection).toHaveBeenCalled()
		expect(database.disconnectFromDatabase).toHaveBeenCalledTimes(1)
	})

	it('retries with FixSession on CI failure and merges', async () => {
		const awaitChecks = github.awaitChecks as jest.MockedFunction<typeof github.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'type error in index.ts' })
			.mockResolvedValueOnce({ passed: true })

		await run()

		expect(git.commitAndPush).toHaveBeenCalledTimes(2)
		expect(fixModule.FixSession).toHaveBeenCalledWith({
			planTitle: 'test-change',
			planDescription: 'A test change',
			planImplementation: 'test implementation',
			createdFiles: ['src/index.test.ts'],
			modifiedFiles: ['src/index.ts'],
		})
		expect(mockFixSession.fix).toHaveBeenCalledWith('type error in index.ts')
		expect(github.mergePR).toHaveBeenCalledWith(1)
	})

	it('closes PR when fixer exhausts turns, then succeeds on next plan', async () => {
		const awaitChecks = github.awaitChecks as jest.MockedFunction<typeof github.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'persistent failure' })
			.mockResolvedValueOnce({ passed: true })

		mockFixerExhausted = true

		await run()

		expect(mockFixSession.fix).not.toHaveBeenCalled()
		expect(github.closePR).toHaveBeenCalledWith(1)
		expect(github.deleteRemoteBranch).toHaveBeenCalledWith('seedgpt/test-change')
		expect(memory.storeReflection).toHaveBeenCalled()
		expect(github.mergePR).toHaveBeenCalled()
	})

	it('handles empty edits without crashing then succeeds on next plan', async () => {
		mockPatchSession.createPatch.mockResolvedValueOnce([] as typeof mockEdits)

		const awaitChecks = github.awaitChecks as jest.MockedFunction<typeof github.awaitChecks>
		awaitChecks.mockResolvedValue({ passed: true })

		await run()

		expect(memory.storeReflection).toHaveBeenCalled()
		expect(github.mergePR).toHaveBeenCalled()
	})

	it('disconnects from database even on crash', async () => {
		const cloneRepo = git.cloneRepo as jest.MockedFunction<typeof git.cloneRepo>
		cloneRepo.mockRejectedValueOnce(new Error('network error'))

		await expect(run()).rejects.toThrow('network error')
		expect(database.disconnectFromDatabase).toHaveBeenCalledTimes(1)
	})

	it('closes PR when fixer.fix throws an error', async () => {
		const awaitChecks = github.awaitChecks as jest.MockedFunction<typeof github.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'build error' })
			.mockResolvedValueOnce({ passed: true })

		mockFixSession.fix.mockRejectedValueOnce(new Error('API timeout'))

		await run()

		expect(github.closePR).toHaveBeenCalledWith(1)
		expect(reflectModule.reflect).toHaveBeenCalledWith(
			expect.stringContaining('API timeout'),
			expect.anything(),
		)
		expect(github.mergePR).toHaveBeenCalled()
	})

	it('closes PR when fixer returns empty edits', async () => {
		const awaitChecks = github.awaitChecks as jest.MockedFunction<typeof github.awaitChecks>
		awaitChecks
			.mockResolvedValueOnce({ passed: false, error: 'test failure' })
			.mockResolvedValueOnce({ passed: true })

		mockFixSession.fix.mockResolvedValueOnce([])

		await run()

		expect(github.closePR).toHaveBeenCalledWith(1)
		expect(reflectModule.reflect).toHaveBeenCalledWith(
			expect.stringContaining('Fixer produced no fix edits'),
			expect.anything(),
		)
		expect(github.mergePR).toHaveBeenCalled()
	})
})
