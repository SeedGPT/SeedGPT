import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type Anthropic from '@anthropic-ai/sdk'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		turns: { maxBuilder: 3 },
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

const { PatchSession } = await import('./build.js')

beforeEach(() => {
	jest.clearAllMocks()
})

const testPlan = {
	title: 'test-change',
	description: 'A test change',
	implementation: 'Edit file.ts',
}

describe('PatchSession', () => {
	it('tracks edited files from edit operations', () => {
		const session = new PatchSession(testPlan)
		expect(session.editedFiles).toEqual({ created: [], modified: [] })
		expect(session.conversation).toEqual(expect.any(Array))
	})

	it('starts not exhausted', () => {
		const session = new PatchSession(testPlan)
		expect(session.exhausted).toBe(false)
	})

	it('completes when done tool is called', async () => {
		const session = new PatchSession(testPlan)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'edit_file', input: { filePath: 'a.ts', oldString: 'old', newString: 'new' } },
				{ type: 'tool_use', id: 't2', name: 'done', input: { summary: 'Changed a.ts' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValueOnce({ type: 'replace', filePath: 'a.ts' })
			.mockReturnValueOnce(null)

		const edits = await session.createPatch()
		expect(edits.length).toBe(1)
	})

	it('throws when builder does not call any tools', async () => {
		const session = new PatchSession(testPlan)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'end_turn', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'text', text: 'I cannot make changes.' }],
		} as unknown as Anthropic.Message)

		await expect(session.createPatch()).rejects.toThrow('did not call any tools')
	})

	it('treats no tools as done if edits exist', async () => {
		const session = new PatchSession(testPlan)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'edit_file', input: { filePath: 'a.ts', oldString: 'x', newString: 'y' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValueOnce({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValueOnce({ type: 'replace', filePath: 'a.ts' })

		mockCallApi.mockResolvedValueOnce({
			id: 'msg2', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'end_turn', stop_sequence: null,
			usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'text', text: 'Done editing.' }],
		} as unknown as Anthropic.Message)

		const edits = await session.createPatch()
		expect(edits.length).toBe(1)
	})

	it('does not push failed edit operations to edits list', async () => {
		const session = new PatchSession(testPlan)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'edit_file', input: { filePath: 'a.ts', oldString: 'missing', newString: 'x' } },
				{ type: 'tool_use', id: 't2', name: 'done', input: { summary: 'Tried' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValueOnce({ type: 'tool_result', tool_use_id: 't1', content: 'error', is_error: true })
			.mockResolvedValueOnce({ type: 'tool_result', tool_use_id: 't2', content: 'ok' })
		mockGetEditOperation.mockImplementation((name: string) => {
			if (name === 'edit_file') return { type: 'replace', filePath: 'a.ts' } as never
			return null
		})

		const edits = await session.createPatch()
		expect(edits.length).toBe(0)
	})

	it('returns edits when max rounds reached with existing edits', async () => {
		const session = new PatchSession(testPlan)

		const toolResponse = {
			id: 'msg', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 'tx', name: 'read_file', input: { filePath: 'a.ts' } }],
		} as unknown as Anthropic.Message

		mockCallApi.mockResolvedValueOnce({
			id: 'msg0', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 't1', name: 'edit_file', input: { filePath: 'b.ts', oldString: 'a', newString: 'b' } }],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation.mockReturnValueOnce({ type: 'replace', filePath: 'b.ts' })
			.mockReturnValue(null)

		mockCallApi.mockResolvedValue(toolResponse)

		const edits = await session.createPatch()
		expect(edits.length).toBe(1)
	})

	it('editedFiles separates created and modified, deduplicating and excluding created from modified', async () => {
		const session = new PatchSession(testPlan)

		mockCallApi.mockResolvedValueOnce({
			id: 'msg1', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [
				{ type: 'tool_use', id: 't1', name: 'create_file', input: { filePath: 'new.ts', content: 'x' } },
				{ type: 'tool_use', id: 't2', name: 'edit_file', input: { filePath: 'existing.ts', oldString: 'a', newString: 'b' } },
				{ type: 'tool_use', id: 't3', name: 'edit_file', input: { filePath: 'new.ts', oldString: 'x', newString: 'y' } },
				{ type: 'tool_use', id: 't4', name: 'done', input: { summary: 'Done' } },
			],
		} as unknown as Anthropic.Message)

		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 't1', content: 'ok' })
		mockGetEditOperation
			.mockReturnValueOnce({ type: 'create', filePath: 'new.ts' })
			.mockReturnValueOnce({ type: 'replace', filePath: 'existing.ts' })
			.mockReturnValueOnce({ type: 'replace', filePath: 'new.ts' })
			.mockReturnValueOnce(null)

		await session.createPatch()

		const { created, modified } = session.editedFiles
		expect(created).toContain('new.ts')
		expect(created).toHaveLength(1)
		expect(modified).toContain('existing.ts')
		expect(modified).not.toContain('new.ts')
	})

	it('throws when max rounds exceeded with no edits', async () => {
		const session = new PatchSession(testPlan)

		const toolResponse = {
			id: 'msg', type: 'message', role: 'assistant', model: 'test',
			stop_reason: 'tool_use', stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: 'tool_use', id: 'tx', name: 'read_file', input: { filePath: 'a.ts' } }],
		} as unknown as Anthropic.Message

		mockCallApi.mockResolvedValue(toolResponse)
		mockHandleTool.mockResolvedValue({ type: 'tool_result', tool_use_id: 'tx', content: 'file content' })
		mockGetEditOperation.mockReturnValue(null)

		await expect(session.createPatch()).rejects.toThrow('exceeded maximum rounds')
	})
})
