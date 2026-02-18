import { jest, describe, it, expect, beforeEach } from '@jest/globals'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		phases: {
			reflect: { model: 'claude-haiku-4-5', maxTokens: 512 },
			memory: { model: 'claude-haiku-4-5', maxTokens: 64 },
			planner: { model: 'claude-sonnet-4-5', maxTokens: 4096 },
			builder: { model: 'claude-sonnet-4-5', maxTokens: 16384 },
			fixer: { model: 'claude-sonnet-4-5', maxTokens: 16384 },
		},
		api: { maxRetries: 2, initialRetryDelay: 10, maxRetryDelay: 50 },
		batch: { pollInterval: 10, maxPollInterval: 50, pollBackoff: 1.5 },
		context: { protectedTurns: 1, minResultChars: 200, maxActiveLines: 2000, contextPadding: 5, thinkingBudget: 10_000 },
	},
}))

jest.unstable_mockModule('../env.js', () => ({
	env: {
		anthropicApiKey: 'test-key',
		workspacePath: './workspace',
	},
}))

jest.unstable_mockModule('../logger.js', () => {
	const noop = () => {}
	return { default: { debug: noop, info: noop, warn: noop, error: noop } }
})

const mockComputeCost = jest.fn<(...args: unknown[]) => number>(() => 0.01)
const mockModelCreate = jest.fn<() => Promise<void>>().mockResolvedValue(undefined as never)

jest.unstable_mockModule('../models/Generated.js', () => ({
	default: { create: mockModelCreate },
	computeCost: mockComputeCost,
}))

jest.unstable_mockModule('../tools/definitions.js', () => ({
	PLANNER_TOOLS: [],
	BUILDER_TOOLS: [],
}))

jest.unstable_mockModule('../tools/codebase.js', () => ({
	getCodebaseContext: jest.fn<() => Promise<string>>().mockResolvedValue('codebase context'),
	findUnusedFunctions: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
	readFile: jest.fn<() => Promise<string>>().mockResolvedValue('file content'),
}))

const mockGetLatestMainCoverage = jest.fn<() => Promise<string | null>>().mockResolvedValue(null)
jest.unstable_mockModule('../tools/github.js', () => ({
	getLatestMainCoverage: mockGetLatestMainCoverage,
}))

const mockGetRecentLog = jest.fn<() => Promise<string>>().mockResolvedValue('abc123 initial commit')
jest.unstable_mockModule('../tools/git.js', () => ({
	getRecentLog: mockGetRecentLog,
}))

const mockGetMemoryContext = jest.fn<() => Promise<string>>().mockResolvedValue('No memories yet.')
jest.unstable_mockModule('../agents/memory.js', () => ({
	getMemoryContext: mockGetMemoryContext,
}))

const mockGetRecentIterationSummary = jest.fn<() => Promise<string>>().mockResolvedValue('')
jest.unstable_mockModule('../agents/analyze.js', () => ({
	getRecentIterationSummary: mockGetRecentIterationSummary,
}))

jest.unstable_mockModule('./prompts.js', () => ({
	SYSTEM_PLAN: 'plan prompt',
	SYSTEM_BUILD: 'build prompt',
	SYSTEM_FIX: 'fix prompt',
	SYSTEM_REFLECT: 'reflect prompt',
	SYSTEM_MEMORY: 'memory prompt',
	SYSTEM_SUMMARIZE: 'summarize prompt',
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockCreate: jest.Mock<(...args: any[]) => any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockBatchCreate: jest.Mock<(...args: any[]) => any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockBatchRetrieve: jest.Mock<(...args: any[]) => any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockBatchResults: jest.Mock<(...args: any[]) => any>

jest.unstable_mockModule('@anthropic-ai/sdk', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockCreate = jest.fn<(...args: any[]) => any>()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockBatchCreate = jest.fn<(...args: any[]) => any>()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockBatchRetrieve = jest.fn<(...args: any[]) => any>()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockBatchResults = jest.fn<(...args: any[]) => any>()
	return {
		default: class {
			messages = {
				create: mockCreate,
				batches: {
					create: mockBatchCreate,
					retrieve: mockBatchRetrieve,
					results: mockBatchResults,
				},
			}
		},
	}
})

const { callApi } = await import('./api.js')

const fakeUsage = { input_tokens: 100, output_tokens: 50 }

const fakeMessage = {
	id: 'msg_1',
	type: 'message' as const,
	role: 'assistant' as const,
	model: 'claude-haiku-4-5',
	content: [{ type: 'text' as const, text: 'hello' }],
	stop_reason: 'end_turn' as const,
	stop_sequence: null,
	usage: fakeUsage,
}

beforeEach(() => {
	mockCreate.mockReset()
	mockBatchCreate.mockReset()
	mockBatchRetrieve.mockReset()
	mockBatchResults.mockReset()
	mockComputeCost.mockReset().mockReturnValue(0.01)
	mockModelCreate.mockReset().mockResolvedValue(undefined as never)
})

function* yieldSucceeded(ids: string[], messages: typeof fakeMessage[]) {
	for (let i = 0; i < ids.length; i++) {
		yield { custom_id: ids[i], result: { type: 'succeeded', message: messages[i] } }
	}
}

function setupBatchMocks(message: typeof fakeMessage = fakeMessage) {
	mockBatchCreate.mockImplementation(async ({ requests }: { requests: Array<{ custom_id: string }> }) => {
		return { id: 'batch_1', processing_status: 'in_progress', _requestIds: requests.map(r => r.custom_id) }
	})
	mockBatchRetrieve.mockResolvedValue({ id: 'batch_1', processing_status: 'ended' })
	mockBatchResults.mockImplementation(async () => {
		const ids = mockBatchCreate.mock.calls[0][0].requests.map((r: { custom_id: string }) => r.custom_id)
		return (async function*() { yield* yieldSucceeded(ids, [message]) })()
	})
}

describe('callApi', () => {
	it('builds params and calls the batch SDK', async () => {
		setupBatchMocks()

		const result = await callApi('reflect', [{ role: 'user', content: 'test' }])

		expect(result).toBe(fakeMessage)
		expect(mockBatchCreate).toHaveBeenCalledTimes(1)
		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { model: string } }> }
		expect(batchParams.requests[0].params.model).toBe('claude-haiku-4-5')
	})

	it('records to Generated after a successful call', async () => {
		setupBatchMocks()

		await callApi('builder', [{ role: 'user', content: 'test' }])

		expect(mockComputeCost).toHaveBeenCalledWith('claude-sonnet-4-5', fakeUsage, { batch: true })
		expect(mockModelCreate).toHaveBeenCalledTimes(1)
		expect((mockModelCreate.mock.calls[0] as unknown[])[0]).toMatchObject({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			batch: true,
		})
	})

	it('throws on errored batch result', async () => {
		mockBatchCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'ended' })
		mockBatchResults.mockImplementation(async () => {
			return (async function*() {
				yield { custom_id: 'req-0', result: { type: 'errored', error: { type: 'server_error', message: 'fail' } } }
			})()
		})

		await expect(callApi('reflect', [{ role: 'user', content: 'test' }])).rejects.toThrow('failed')
	})

	it('throws when batch returns no results', async () => {
		mockBatchCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'ended' })
		mockBatchResults.mockImplementation(async () => {
			return (async function*() {})()
		})

		await expect(callApi('reflect', [{ role: 'user', content: 'test' }])).rejects.toThrow('no results')
	})

	it('passes extra tools when provided', async () => {
		setupBatchMocks()
		const extraTool = { name: 'test_tool', description: 'test', input_schema: { type: 'object' as const, properties: {} } }

		await callApi('reflect', [{ role: 'user', content: 'test' }], [extraTool])

		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { tools?: unknown[] } }> }
		expect(batchParams.requests[0].params.tools).toEqual([extraTool])
	})

	it('includes coverage, git log, codebase, memory in planner system prompt', async () => {
		setupBatchMocks()
		mockGetLatestMainCoverage.mockResolvedValueOnce('85.5%')
		mockGetRecentLog.mockResolvedValueOnce('abc123 test commit')
		mockGetMemoryContext.mockResolvedValueOnce('Memory: learned X')

		await callApi('planner', [{ role: 'user', content: 'plan' }])

		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { system: Array<{ text: string }> } }> }
		const systemTexts = batchParams.requests[0].params.system.map((s: { text: string }) => s.text)
		const joined = systemTexts.join('\n')

		expect(joined).toContain('85.5%')
		expect(joined).toContain('abc123 test commit')
		expect(joined).toContain('codebase context')
		expect(joined).toContain('Memory: learned X')
	})

	it('includes codebase context for builder phase', async () => {
		setupBatchMocks()

		await callApi('builder', [{ role: 'user', content: 'build' }])

		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { system: Array<{ text: string }> } }> }
		const systemTexts = batchParams.requests[0].params.system.map((s: { text: string }) => s.text)
		expect(systemTexts.some((t: string) => t.includes('codebase context'))).toBe(true)
	})

	it('includes unused functions in planner when present', async () => {
		setupBatchMocks()
		const findUnused = (await import('../tools/codebase.js')).findUnusedFunctions as jest.MockedFunction<() => Promise<string | null>>
		findUnused.mockResolvedValueOnce('src/util.ts: deadFunc')

		await callApi('planner', [{ role: 'user', content: 'plan' }])

		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { system: Array<{ text: string }> } }> }
		const systemTexts = batchParams.requests[0].params.system.map((s: { text: string }) => s.text)
		expect(systemTexts.some((t: string) => t.includes('deadFunc'))).toBe(true)
	})

	it('applies cache_control to last block before working context', async () => {
		setupBatchMocks()
		mockGetLatestMainCoverage.mockResolvedValueOnce('90%')
		mockGetRecentLog.mockResolvedValueOnce('log')
		mockGetMemoryContext.mockResolvedValueOnce('mem')
		const findUnused = (await import('../tools/codebase.js')).findUnusedFunctions as jest.MockedFunction<() => Promise<string | null>>
		findUnused.mockResolvedValueOnce('dead code')

		await callApi('planner', [{ role: 'user', content: 'plan' }])

		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { system: Array<{ text: string; cache_control?: unknown }> } }> }
		const blocks = batchParams.requests[0].params.system
		const cached = blocks.filter((b: { cache_control?: unknown }) => b.cache_control)
		expect(cached.length).toBe(1)
		const cachedBlock = cached[0] as { text: string }
		expect(cachedBlock.text).not.toContain('Working Context')
	})

	it('handles GeneratedModel.create failure gracefully', async () => {
		setupBatchMocks()
		mockModelCreate.mockRejectedValueOnce(new Error('DB write failed'))

		const result = await callApi('reflect', [{ role: 'user', content: 'test' }])
		expect(result).toBe(fakeMessage)
	})

	it('enables extended thinking for builder phase', async () => {
		setupBatchMocks()

		await callApi('builder', [{ role: 'user', content: 'build' }])

		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { thinking?: { type: string; budget_tokens: number }; max_tokens: number } }> }
		const params = batchParams.requests[0].params
		expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 10_000 })
		expect(params.max_tokens).toBe(16384 + 10_000)
	})

	it('enables extended thinking for reflect phase', async () => {
		setupBatchMocks()

		await callApi('reflect', [{ role: 'user', content: 'test' }])

		const batchParams = mockBatchCreate.mock.calls[0][0] as { requests: Array<{ params: { thinking?: { type: string; budget_tokens: number }; max_tokens: number } }> }
		const params = batchParams.requests[0].params
		expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: expect.any(Number) })
		expect(params.max_tokens).toBe(512 + params.thinking!.budget_tokens)
	})

	it('polls batch until ended with backoff', async () => {
		mockBatchCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'in_progress' })
		mockBatchRetrieve
			.mockResolvedValueOnce({ id: 'batch_1', processing_status: 'in_progress' })
			.mockResolvedValueOnce({ id: 'batch_1', processing_status: 'ended' })
		mockBatchResults.mockImplementation(async () => {
			return (async function*() {
				yield { custom_id: 'req-0', result: { type: 'succeeded', message: fakeMessage } }
			})()
		})

		const result = await callApi('reflect', [{ role: 'user', content: 'test' }])
		expect(result).toBe(fakeMessage)
		expect(mockBatchRetrieve).toHaveBeenCalledTimes(2)
	})
})
