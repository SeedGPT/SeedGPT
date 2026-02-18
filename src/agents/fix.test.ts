import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type Anthropic from '@anthropic-ai/sdk'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		turns: { maxFixer: 3 },
	},
}))

jest.unstable_mockModule('../logger.js', () => ({
	default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
	toolLogSuffix: () => '',
}))

const mockHandleTool = jest.fn<(name: string, input: Record<string, unknown>, id: string) => Promise<{ type: string; tool_use_id: string; content: string; is_error?: boolean }>>()
const mockGetEditOperation = jest.fn<(name: string, input: Record<string, unknown>) => { type: string; filePath: string } | null>()

jest.unstable_mockModule('../tools/definitions.js', () => ({
	handleTool: mockHandleTool,
	getEditOperation: mockGetEditOperation,
}))

const mockCallApi = jest.fn<(phase: string, messages: Anthropic.MessageParam[]) => Promise<Anthropic.Message>>()

jest.unstable_mockModule('../llm/api.js', () => ({
	callApi: mockCallApi,
}))

const { FixSession } = await import('./fix.js')

beforeEach(() => {
	jest.clearAllMocks()
})

const fixContext = {
	planTitle: 'test-change',
	planDescription: 'A test change',
	implementation: 'Add caching to the API module using a Map',
	createdFiles: ['new.ts'],
	modifiedFiles: ['existing.ts'],
}

describe('FixSession', () => {
	it('starts not exhausted', () => {
		const session = new FixSession(fixContext)
		expect(session.exhausted).toBe(false)
	})

	it('fixes an error by applying edits and calling done', async () => {
		const session = new FixSession(fixContext)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'edit_file', input: { filePath: 'existing.ts', oldString: 'bug', newString: 'fix' } },
				{ type: 'tool_use', id: 't2', name: 'done', input: { summary: 'Fixed the bug' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValueOnce({ type: 'replace', filePath: 'existing.ts' })
			.mockReturnValueOnce(null)

		const edits = await session.fix('TypeError: cannot read property')
		expect(edits.length).toBe(1)
	})

	it('throws when fixer does not call any tools', async () => {
		const session = new FixSession(fixContext)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'end_turn', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'text', text: 'I cannot fix this.' }],
		} as unknown as Anthropic.Message)

		await expect(session.fix('error')).rejects.toThrow('did not call any tools')
	})

	it('returns edits on max rounds if edits exist', async () => {
		const session = new FixSession(fixContext)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg0', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 't1', name: 'edit_file', input: { filePath: 'a.ts', oldString: 'x', newString: 'y' } }],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValueOnce({ type: 'replace', filePath: 'a.ts' })
			.mockReturnValue(null)

		const readResponse = {
			id: 'msg', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 'tx', name: 'read_file', input: { filePath: 'a.ts' } }],
		} as unknown as Anthropic.Message
		mockCallApi.mockResolvedValue(readResponse)

		const edits = await session.fix('error')
		expect(edits.length).toBe(1)
	})

	it('throws on max rounds with no edits', async () => {
		const session = new FixSession(fixContext)

		const readResponse = {
			id: 'msg', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 'tx', name: 'read_file', input: { filePath: 'a.ts' } }],
		} as unknown as Anthropic.Message

		mockCallApi.mockResolvedValue(readResponse)
		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 'tx', content: 'content' })
		mockGetEditOperation.mockReturnValue(null)

		await expect(session.fix('error')).rejects.toThrow('exceeded maximum rounds')
	})

	it('treats no tools as done if edits exist', async () => {
		const session = new FixSession(fixContext)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'edit_file', input: { filePath: 'a.ts', oldString: 'a', newString: 'b' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValueOnce({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValueOnce({ type: 'replace', filePath: 'a.ts' })

		mockCallApi.mockResolvedValueOnce({
			id: 'msg2', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'end_turn', stop_sequence: null,
			usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'text', text: 'Fixed.' }],
		} as unknown as Anthropic.Message)

		const edits = await session.fix('some error')
		expect(edits.length).toBe(1)
	})

	it('includes attempt number in subsequent fix calls', async () => {
		const session = new FixSession(fixContext)

		const doneResponse = {
			id: 'msg', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 't1', name: 'done', input: { summary: 'Fixed' } }],
		} as unknown as Anthropic.Message

		mockCallApi.mockResolvedValue(doneResponse)
		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValue(null)

		await session.fix('first error')
		await session.fix('second error')

		const allMessages = session.conversation
		const userMessages = allMessages.filter(m => m.role === 'user' && typeof m.content === 'string')
		const secondFixMsg = userMessages[1]
		expect(secondFixMsg.content).toContain('fix attempt 2')
		expect(secondFixMsg.content).toContain('CI was re-run')
	})

	it('includes warning on attempt 2 after a failed first attempt', async () => {
		const session = new FixSession(fixContext)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'end_turn', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'text', text: 'I cannot fix this.' }],
		} as unknown as Anthropic.Message)

		await expect(session.fix('first error')).rejects.toThrow('did not call any tools')

		const doneResponse = {
			id: 'msg2', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 't1', name: 'done', input: { summary: 'Fixed' } }],
		} as unknown as Anthropic.Message

		mockCallApi.mockResolvedValueOnce(doneResponse)
		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValue(null)

		await session.fix('second error')

		const allMessages = session.conversation
		const userMessages = allMessages.filter(m => m.role === 'user' && typeof m.content === 'string')
		const secondFixMsg = userMessages[1]
		expect(secondFixMsg.content).toContain('fix attempt 2')
		expect(secondFixMsg.content).toContain('CI was re-run')
	})
})
