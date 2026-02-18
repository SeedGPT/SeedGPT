import { jest, describe, it, expect, beforeEach } from '@jest/globals'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		summarization: {
			charThreshold: 20_000,
			minResultChars: 300,
			protectedTurns: 2,
			model: 'claude-haiku-4-5',
			maxTokens: 2048,
		},
	},
}))

jest.unstable_mockModule('../logger.js', () => {
	const buffer: Array<{ timestamp: string; level: string; message: string; context?: Record<string, unknown> }> = []
	const noop = () => {}
	return {
		default: { debug: noop, info: noop, warn: noop, error: noop },
		getLogBuffer: () => buffer,
	}
})

const mockCallApi = jest.fn<((...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; usage: { input_tokens: number; output_tokens: number } }>)>()
	.mockResolvedValue({
		content: [{ type: 'text', text: 'Thoughtful reflection on the iteration.' }],
		usage: { input_tokens: 500, output_tokens: 50 },
	})

jest.unstable_mockModule('../llm/api.js', () => ({
	callApi: mockCallApi,
}))

const { reflect } = await import('./reflect.js')

beforeEach(() => {
	jest.clearAllMocks()
})

describe('reflect', () => {
	it('calls the API with a transcript of the conversation', async () => {
		const result = await reflect('PR #1 merged successfully.', [
			{ role: 'user', content: 'Start working' },
			{ role: 'assistant', content: [{ type: 'text', text: 'I will implement the change.' }] },
		])

		expect(mockCallApi).toHaveBeenCalledTimes(1)
		expect(mockCallApi).toHaveBeenCalledWith('reflect', expect.any(Array))
		const callArgs = mockCallApi.mock.calls[0] as unknown[]
		const messages = callArgs[1] as Array<{ role: string; content: string }>
		expect(messages.length).toBe(1)
		expect(messages[0].content).toContain('## Outcome')
		expect(messages[0].content).toContain('PR #1 merged successfully.')
		expect(messages[0].content).toContain('## Conversation')
		expect(result).toBe('Thoughtful reflection on the iteration.')
	})

	it('includes tool use and tool result blocks in the transcript', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [
					{ type: 'text' as const, text: 'Let me read the file' },
					{ type: 'tool_use' as const, id: 't1', name: 'read_file', input: { filePath: 'src/a.ts' } },
				],
			},
			{
				role: 'user' as const,
				content: [
					{ type: 'tool_result' as const, tool_use_id: 't1', content: 'file contents here' },
				],
			},
		]

		await reflect('Change succeeded.', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[tool: read_file]')
		expect(transcript).toContain('[Read src/a.ts')
	})

	it('marks error tool results', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{ type: 'tool_use' as const, id: 't1', name: 'read_file', input: { filePath: 'missing.ts' } }],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'File not found', is_error: true }],
			},
		]

		await reflect('Failed', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[result ERROR]')
	})

	it('returns empty string when API returns no text blocks', async () => {
		mockCallApi.mockResolvedValueOnce({
			content: [],
			usage: { input_tokens: 100, output_tokens: 10 },
		})

		const result = await reflect('outcome', [])
		expect(result).toBe('')
	})

	it('includes iteration log in the transcript', async () => {
		const { getLogBuffer } = await import('../logger.js')
		const buffer = getLogBuffer() as Array<{ timestamp: string; level: string; message: string }>
		buffer.push({ timestamp: '2025-01-01T12:00:00.000Z', level: 'info', message: 'Test log entry' })

		await reflect('Done', [])

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('## Iteration Log')
		expect(transcript).toContain('Test log entry')

		buffer.length = 0
	})

	it('handles string-only assistant messages', async () => {
		const messages = [
			{ role: 'assistant' as const, content: 'Simple string response' },
		]

		await reflect('outcome', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('Simple string response')
	})

	it('summarizes grep_search results in transcript', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{ type: 'tool_use' as const, id: 't1', name: 'grep_search', input: { query: 'findme' } }],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'file.ts:1: findme\nfile.ts:5: findme' }],
			},
		]

		await reflect('Done', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[Searched "findme": 2 matches]')
	})

	it('summarizes file_search results in transcript', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{ type: 'tool_use' as const, id: 't1', name: 'file_search', input: { query: '**/*.ts' } }],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'a.ts\nb.ts\nc.ts' }],
			},
		]

		await reflect('Done', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[File search: 3 results]')
	})

	it('summarizes list_directory results in transcript', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{ type: 'tool_use' as const, id: 't1', name: 'list_directory', input: { path: 'src' } }],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'a.ts\nb.ts' }],
			},
		]

		await reflect('Done', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[Listed src: 2 entries]')
	})

	it('summarizes git_diff results in transcript', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{ type: 'tool_use' as const, id: 't1', name: 'git_diff', input: {} }],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'diff --git a/f.ts b/f.ts\n+line' }],
			},
		]

		await reflect('Done', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[Diff: 2 lines]')
	})

	it('summarizes codebase_context results in transcript', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{ type: 'tool_use' as const, id: 't1', name: 'codebase_context', input: {} }],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'line1\nline2\nline3' }],
			},
		]

		await reflect('Done', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[Codebase context viewed: 3 lines]')
	})

	it('uses default summary for unknown tool names', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{ type: 'tool_use' as const, id: 't1', name: 'custom_tool', input: {} }],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'some custom result' }],
			},
		]

		await reflect('Done', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('some custom result')
	})

	it('expands submit_plan with full plan content', async () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: [{
					type: 'tool_use' as const,
					id: 't1',
					name: 'submit_plan',
					input: { title: 'Add caching', description: 'Cache API responses', implementation: 'Use Map in api.ts' },
				}],
			},
			{
				role: 'user' as const,
				content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'Plan submitted.' }],
			},
		]

		await reflect('Done', messages)

		const transcript = ((mockCallApi.mock.calls[0] as unknown[])[1] as Array<{ content: string }>)[0].content
		expect(transcript).toContain('[PLAN] Add caching')
		expect(transcript).toContain('Cache API responses')
		expect(transcript).toContain('Use Map in api.ts')
		expect(transcript).not.toContain('[tool: submit_plan]')
	})
})
