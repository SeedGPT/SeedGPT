import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type Anthropic from '@anthropic-ai/sdk'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		turns: { maxPlanner: 3 },
	},
}))

jest.unstable_mockModule('../logger.js', () => ({
	default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
	toolLogSuffix: () => '',
}))

const mockHandleTool = jest.fn<(name: string, input: Record<string, unknown>, id: string) => Promise<{ type: string; tool_use_id: string; content: string; is_error?: boolean }>>()

jest.unstable_mockModule('../tools/definitions.js', () => ({
	handleTool: mockHandleTool,
}))

const mockCallApi = jest.fn<(phase: string, messages: Anthropic.MessageParam[]) => Promise<Anthropic.Message>>()

jest.unstable_mockModule('../llm/api.js', () => ({
	callApi: mockCallApi,
}))

const { plan } = await import('./plan.js')

beforeEach(() => {
	jest.clearAllMocks()
})

describe('plan', () => {
	it('returns plan when submit_plan is called on first turn', async () => {
		mockCallApi.mockResolvedValueOnce({
			id: 'msg1',
			type: 'message',
			role: 'assistant',
			model: 'test',
			stop_reason: 'tool_use',
			stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'text', text: 'I will improve tests.' },
				{
					type: 'tool_use', id: 't1', name: 'submit_plan',
					input: { title: 'add-tests', description: 'Add test coverage', implementation: 'Add tests to config.ts' },
				},
			],
		} as unknown as Anthropic.Message)

		const result = await plan()
		expect(result.plan.title).toBe('add-tests')
		expect(result.plan.description).toBe('Add test coverage')
		expect(result.plan.implementation).toBe('Add tests to config.ts')
	})

	it('uses tools before submitting plan', async () => {
		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'read_file', input: { filePath: 'src/config.ts' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValueOnce({
			type: 'tool_result', tool_use_id: 't1', content: 'const config = {}',
		})

		mockCallApi.mockResolvedValueOnce({
			id: 'msg2', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'text', text: 'After reading the file, here is my plan.' },
				{
					type: 'tool_use', id: 't2', name: 'submit_plan',
					input: { title: 'refactor', description: 'Clean up config', implementation: 'Restructure config.ts' },
				},
			],
		} as unknown as Anthropic.Message)

		const result = await plan()
		expect(mockHandleTool).toHaveBeenCalledTimes(1)
		expect(result.plan.title).toBe('refactor')
	})

	it('throws when no tool_use blocks returned', async () => {
		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'end_turn', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'text', text: 'I have no plan.' }],
		} as unknown as Anthropic.Message)

		await expect(plan()).rejects.toThrow('did not return a tool_use block')
	})

	it('throws when max rounds exceeded without submit_plan', async () => {
		const toolResponse = {
			id: 'msg', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 'tx', name: 'read_file', input: { filePath: 'a.ts' } }],
		} as unknown as Anthropic.Message

		mockCallApi.mockResolvedValue(toolResponse)
		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 'tx', content: 'file content' })

		await expect(plan()).rejects.toThrow('exceeded maximum rounds')
	})

	it('appends turn hint to last tool result, not first', async () => {
		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'read_file', input: { filePath: 'a.ts' } },
				{ type: 'tool_use', id: 't2', name: 'grep_search', input: { query: 'test' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool
			.mockResolvedValueOnce({ type: 'tool_result', tool_use_id: 't1', content: 'file-a' })
			.mockResolvedValueOnce({ type: 'tool_result', tool_use_id: 't2', content: 'grep-result' })

		mockCallApi.mockResolvedValueOnce({
			id: 'msg2', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't3', name: 'submit_plan',
					input: { title: 'test', description: 'desc', implementation: 'impl' } },
			],
		} as unknown as Anthropic.Message)

		const result = await plan()
		expect(result.plan.title).toBe('test')

		const userMsg = result.messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.length === 2) as { content: Array<{ content: string }> }
		expect(userMsg.content[0].content).not.toContain('Turn ')
		expect(userMsg.content[1].content).toContain('Turn 1 of 3')
	})
})
