import { jest, describe, it, expect, beforeEach } from '@jest/globals'

jest.unstable_mockModule('../env.js', () => ({
	env: { workspacePath: '/workspace' },
}))

jest.unstable_mockModule('../config.js', () => ({
	config: { tools: { defaultReadWindow: 300 } },
}))

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
jest.unstable_mockModule('../logger.js', () => ({
	default: mockLogger,
}))

const mockReadFile = jest.fn<() => Promise<string>>()
const mockGrepSearch = jest.fn<() => Promise<string>>()
const mockFileSearch = jest.fn<() => Promise<string>>()
const mockListDirectory = jest.fn<() => Promise<string>>()

jest.unstable_mockModule('./codebase.js', () => ({
	readFile: mockReadFile,
	grepSearch: mockGrepSearch,
	fileSearch: mockFileSearch,
	listDirectory: mockListDirectory,
}))

const mockApplyEdits = jest.fn<() => Promise<void>>()
const mockGetDiff = jest.fn<() => Promise<string>>()

jest.unstable_mockModule('./git.js', () => ({
	applyEdits: mockApplyEdits,
	getDiff: mockGetDiff,
}))

const mockStoreNote = jest.fn<() => Promise<string>>()
const mockDismissNote = jest.fn<() => Promise<string>>()
const mockRecall = jest.fn<() => Promise<string>>()
const mockRecallById = jest.fn<() => Promise<string>>()

jest.unstable_mockModule('../agents/memory.js', () => ({
	storeNote: mockStoreNote,
	dismissNote: mockDismissNote,
	recall: mockRecall,
	recallById: mockRecallById,
}))

const { handleTool } = await import('./handlers.js')

beforeEach(() => {
	jest.clearAllMocks()
	mockApplyEdits.mockResolvedValue(undefined)
})

describe('handleTool', () => {
	it('read_file with startLine but no endLine uses lines.length as fallback', async () => {
		mockReadFile.mockResolvedValue('line1\nline2\nline3\nline4\nline5')
		const result = await handleTool('read_file', { filePath: 'test.ts', startLine: 2 }, 'id1')
		expect(result.type).toBe('tool_result')
		expect(result.tool_use_id).toBe('id1')
		expect(result.is_error).toBeUndefined()
		expect(result.content).toContain('line2')
	})

	it('file_search returning 1 result logs singular "1 file"', async () => {
		mockFileSearch.mockResolvedValue('src/index.ts')
		const result = await handleTool('file_search', { query: '**/*.ts' }, 'id2')
		expect(result.content).toBe('src/index.ts')
		expect(result.is_error).toBeUndefined()
		expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('1 file'))
		const call = mockLogger.info.mock.calls.find((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('file'))
		expect(call?.[0]).not.toContain('1 files')
	})

	it('git_diff returns diff content', async () => {
		const diff = 'diff --git a/test.ts b/test.ts\n+new line'
		mockGetDiff.mockResolvedValue(diff)
		const result = await handleTool('git_diff', {}, 'id3')
		expect(result.content).toBe(diff)
		expect(result.is_error).toBeUndefined()
	})

	it('edit_file returns is_error when applyEdits throws', async () => {
		mockApplyEdits.mockRejectedValueOnce(new Error('conflict'))
		const result = await handleTool('edit_file', { filePath: 'a.ts', oldString: 'old', newString: 'new' }, 'id4')
		expect(result.is_error).toBe(true)
		expect(result.content).toBe('conflict')
	})

	it('create_file with 1-line content logs singular "1 line"', async () => {
		const result = await handleTool('create_file', { filePath: 'new.ts', content: 'hello' }, 'id5')
		expect(result.content).toBe('Created new.ts')
		expect(result.is_error).toBeUndefined()
		expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('1 line'))
		const call = mockLogger.info.mock.calls.find((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('line'))
		expect(call?.[0]).not.toContain('1 lines')
	})

	it('create_file returns is_error when applyEdits throws', async () => {
		mockApplyEdits.mockRejectedValueOnce(new Error('no permission'))
		const result = await handleTool('create_file', { filePath: 'new.ts', content: 'hello' }, 'id6')
		expect(result.is_error).toBe(true)
		expect(result.content).toBe('no permission')
	})

	it('delete_file returns is_error when applyEdits throws', async () => {
		mockApplyEdits.mockRejectedValueOnce(new Error('not found'))
		const result = await handleTool('delete_file', { filePath: 'gone.ts' }, 'id7')
		expect(result.is_error).toBe(true)
		expect(result.content).toBe('not found')
	})
})
