import { jest, describe, it, expect, beforeEach } from '@jest/globals'

jest.unstable_mockModule('../env.js', () => ({
	env: { workspacePath: '/test/workspace' },
}))

jest.unstable_mockModule('../logger.js', () => ({
	default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const logger = (await import('../logger.js')).default as unknown as Record<string, jest.Mock>

const mockStoreNote = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('Note saved.')
const mockDismissNote = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('Note dismissed.')
const mockRecall = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('Memory content here.')
const mockRecallById = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('Memory by id content.')

const mockListIterations = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('[2025-01-03] 673abc123: success\n[2025-01-02] 673abc122: failure')

jest.unstable_mockModule('../agents/memory.js', () => ({
	storeNote: mockStoreNote,
	dismissNote: mockDismissNote,
	recall: mockRecall,
	recallById: mockRecallById,
	listIterations: mockListIterations,
}))

const mockReadFile = jest.fn<(root: string, path: string) => Promise<string>>()
const mockGrepSearch = jest.fn<(root: string, query: string, opts?: { includePattern?: string }) => Promise<string>>()
const mockFileSearch = jest.fn<(root: string, glob: string) => Promise<string>>()
const mockListDirectory = jest.fn<(root: string, dir: string) => Promise<string>>()

jest.unstable_mockModule('./codebase.js', () => ({
	readFile: mockReadFile,
	grepSearch: mockGrepSearch,
	fileSearch: mockFileSearch,
	listDirectory: mockListDirectory,
}))

const mockApplyEdits = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const mockGetDiff = jest.fn<(...args: unknown[]) => Promise<string>>()

jest.unstable_mockModule('./git.js', () => ({
	applyEdits: mockApplyEdits,
	getDiff: mockGetDiff,
}))

const { handleTool, getEditOperation } = await import('./definitions.js')

beforeEach(() => {
	jest.clearAllMocks()
})

describe('getEditOperation', () => {
	it('returns FileEdit for edit_file', () => {
		const result = getEditOperation('edit_file', { filePath: 'a.ts', oldString: 'old', newString: 'new' })
		expect(result).toEqual({ type: 'replace', filePath: 'a.ts', oldString: 'old', newString: 'new' })
	})

	it('returns FileCreate for create_file', () => {
		const result = getEditOperation('create_file', { filePath: 'b.ts', content: 'hello' })
		expect(result).toEqual({ type: 'create', filePath: 'b.ts', content: 'hello' })
	})

	it('returns FileDelete for delete_file', () => {
		const result = getEditOperation('delete_file', { filePath: 'c.ts' })
		expect(result).toEqual({ type: 'delete', filePath: 'c.ts' })
	})

	it('returns null for non-edit tools', () => {
		expect(getEditOperation('read_file', { filePath: 'a.ts' })).toBeNull()
		expect(getEditOperation('done', { summary: 'done' })).toBeNull()
		expect(getEditOperation('grep_search', { query: 'test' })).toBeNull()
	})
})

describe('handleTool', () => {
	describe('read_file', () => {
		it('reads full file and adds line numbers', async () => {
			mockReadFile.mockResolvedValue('line1\nline2\nline3')
			const result = await handleTool('read_file', { filePath: 'test.ts' }, 'id1')
			expect(result.content).toContain('1 | line1')
			expect(result.content).toContain('2 | line2')
			expect(result.content).toContain('3 | line3')
			expect(result.is_error).toBeUndefined()
		})

		it('truncates files exceeding 300 lines', async () => {
			const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`)
			mockReadFile.mockResolvedValue(lines.join('\n'))
			const result = await handleTool('read_file', { filePath: 'big.ts' }, 'id1')
			expect(result.content).toContain('Showing first 300 of 400 lines')
		})

		it('reads a specific line range', async () => {
			const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
			mockReadFile.mockResolvedValue(lines.join('\n'))
			const result = await handleTool('read_file', { filePath: 'test.ts', startLine: 5, endLine: 10 }, 'id1')
			expect(result.content).toContain('5 | line 5')
			expect(result.content).toContain('10 | line 10')
			expect(result.content).not.toContain('4 | ')
			expect(result.content).not.toContain('11 | ')
		})

		it('line numbers in startLine range are 1-based', async () => {
			const lines = Array.from({ length: 10 }, (_, i) => `content-${i}`)
			mockReadFile.mockResolvedValue(lines.join('\n'))
			const result = await handleTool('read_file', { filePath: 'test.ts', startLine: 3, endLine: 5 }, 'id1')
			expect(result.content).toMatch(/^3 \| content-2/m)
			expect(result.content).toMatch(/^4 \| content-3/m)
			expect(result.content).toMatch(/^5 \| content-4/m)
			expect(result.content).not.toMatch(/^2 \| /m)
		})

		it('caps line range to MAX_LINES', async () => {
			const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`)
			mockReadFile.mockResolvedValue(lines.join('\n'))
			const result = await handleTool('read_file', { filePath: 'test.ts', startLine: 1, endLine: 400 }, 'id1')
			expect(result.content).toContain('Showing 300 of 400 requested lines')
		})

		it('returns error for missing file', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT'))
			const result = await handleTool('read_file', { filePath: 'missing.ts' }, 'id1')
			expect(result.is_error).toBe(true)
			expect(result.content).toContain('File not found: missing.ts')
		})
	})

	describe('grep_search', () => {
		it('returns search results with match count', async () => {
			mockGrepSearch.mockResolvedValue('test.ts:5: const x = 1\ntest.ts:10: const y = 2')
			const result = await handleTool('grep_search', { query: 'const' }, 'id1')
			expect(result.content).toContain('test.ts:5:')
		})

		it('passes includePattern to search', async () => {
			mockGrepSearch.mockResolvedValue('No matches found.')
			await handleTool('grep_search', { query: 'test', includePattern: '*.ts' }, 'id1')
			expect(mockGrepSearch).toHaveBeenCalledWith('/test/workspace', 'test', { includePattern: '*.ts' })
		})

		it('handles no matches', async () => {
			mockGrepSearch.mockResolvedValue('No matches found.')
			const result = await handleTool('grep_search', { query: 'nonexistent' }, 'id1')
			expect(result.content).toBe('No matches found.')
		})

		it('logs singular "match" for exactly 1 result', async () => {
			mockGrepSearch.mockResolvedValue('test.ts:5: single line')
			await handleTool('grep_search', { query: 'single' }, 'id1')
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 match'))
			expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('1 matches'))
		})

		it('logs plural "matches" for 0 or multiple results', async () => {
			mockGrepSearch.mockResolvedValue('a.ts:1: x\nb.ts:2: y')
			await handleTool('grep_search', { query: 'x' }, 'id1')
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('2 matches'))
		})
	})

	describe('file_search', () => {
		it('returns matching files', async () => {
			mockFileSearch.mockResolvedValue('src/a.ts\nsrc/b.ts')
			const result = await handleTool('file_search', { query: '**/*.ts' }, 'id1')
			expect(result.content).toContain('src/a.ts')
		})

		it('handles no files matched', async () => {
			mockFileSearch.mockResolvedValue('No files matched.')
			const result = await handleTool('file_search', { query: '**/*.xyz' }, 'id1')
			expect(result.content).toBe('No files matched.')
		})
	})

	describe('list_directory', () => {
		it('returns directory contents', async () => {
			mockListDirectory.mockResolvedValue('file1.ts\nfile2.ts\nsubdir/')
			const result = await handleTool('list_directory', { path: 'src' }, 'id1')
			expect(result.content).toContain('file1.ts')
		})

		it('logs plural "entries" for multiple items', async () => {
			mockListDirectory.mockResolvedValue('a.ts\nb.ts')
			await handleTool('list_directory', { path: 'src' }, 'id1')
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('2 entries'))
		})

		it('logs singular "entry" for one item', async () => {
			mockListDirectory.mockResolvedValue('only.ts')
			await handleTool('list_directory', { path: 'src' }, 'id1')
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 entry'))
			expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('1 entries'))
		})

		it('returns error for missing directory', async () => {
			mockListDirectory.mockRejectedValue(new Error('ENOENT'))
			const result = await handleTool('list_directory', { path: 'nonexistent' }, 'id1')
			expect(result.is_error).toBe(true)
			expect(result.content).toContain('Directory not found: nonexistent')
		})
	})

	describe('note_to_self', () => {
		it('stores a note', async () => {
			const result = await handleTool('note_to_self', { content: 'Remember this' }, 'id1')
			expect(mockStoreNote).toHaveBeenCalledWith('Remember this')
			expect(result.content).toBe('Note saved.')
		})
	})

	describe('dismiss_note', () => {
		it('dismisses a note by id', async () => {
			const result = await handleTool('dismiss_note', { id: 'note-123' }, 'id1')
			expect(mockDismissNote).toHaveBeenCalledWith('note-123')
			expect(result.content).toBe('Note dismissed.')
		})
	})

	describe('recall_memory', () => {
		it('recalls by query', async () => {
			const result = await handleTool('recall_memory', { query: 'test query' }, 'id1')
			expect(mockRecall).toHaveBeenCalledWith('test query')
			expect(result.content).toBe('Memory content here.')
		})

		it('recalls by id (priority over query)', async () => {
			const result = await handleTool('recall_memory', { id: 'mem-456', query: 'query' }, 'id1')
			expect(mockRecallById).toHaveBeenCalledWith('mem-456')
		})

		it('returns message when neither query nor id given', async () => {
			const result = await handleTool('recall_memory', {}, 'id1')
			expect(result.content).toContain('Provide a query or id')
		})
	})

	describe('list_iterations', () => {
		it('lists iterations with default limit', async () => {
			const result = await handleTool('list_iterations', {}, 'id1')
			expect(mockListIterations).toHaveBeenCalledWith(10)
			expect(result.content).toContain('[2025-01-03] 673abc123: success')
		})

		it('respects custom limit parameter', async () => {
			const result = await handleTool('list_iterations', { limit: 5 }, 'id1')
			expect(mockListIterations).toHaveBeenCalledWith(5)
			expect(result.content).toContain('[2025-01-03] 673abc123: success')
		})
	})

	describe('git_diff', () => {
		it('returns diff content', async () => {
			mockGetDiff.mockResolvedValue('diff --git a/test.ts b/test.ts\n+added line')
			const result = await handleTool('git_diff', {}, 'id1')
			expect(result.content).toContain('diff --git')
		})
	})

	describe('edit_file', () => {
		it('applies edit and reports location', async () => {
			mockReadFile.mockResolvedValue('const x = 42\nconst y = 2')
			const result = await handleTool('edit_file', { filePath: 'test.ts', oldString: 'x = 1', newString: 'x = 42' }, 'id1')
			expect(mockApplyEdits).toHaveBeenCalledWith([{ type: 'replace', filePath: 'test.ts', oldString: 'x = 1', newString: 'x = 42' }])
			expect(result.content).toContain('Replaced text in test.ts')
		})

		it('reports when newString not found in result (applied fallback)', async () => {
			mockReadFile.mockResolvedValue('const z = 99')
			const result = await handleTool('edit_file', { filePath: 'test.ts', oldString: 'a', newString: 'b' }, 'id1')
			expect(result.content).toContain('Replaced text in test.ts')
		})

		it('returns error on failed edit', async () => {
			mockApplyEdits.mockRejectedValueOnce(new Error('oldString not found in file'))
			const result = await handleTool('edit_file', { filePath: 'test.ts', oldString: 'missing', newString: 'x' }, 'id1')
			expect(result.is_error).toBe(true)
			expect(result.content).toContain('oldString not found')
		})
	})

	describe('create_file', () => {
		it('creates file and returns success', async () => {
			const result = await handleTool('create_file', { filePath: 'new.ts', content: 'hello\nworld' }, 'id1')
			expect(mockApplyEdits).toHaveBeenCalledWith([{ type: 'create', filePath: 'new.ts', content: 'hello\nworld' }])
			expect(result.content).toContain('Created new.ts')
		})

		it('returns error on failure', async () => {
			mockApplyEdits.mockRejectedValueOnce(new Error('File already exists'))
			const result = await handleTool('create_file', { filePath: 'exists.ts', content: 'x' }, 'id1')
			expect(result.is_error).toBe(true)
			expect(result.content).toContain('File already exists')
		})
	})

	describe('delete_file', () => {
		it('deletes file and returns success', async () => {
			const result = await handleTool('delete_file', { filePath: 'old.ts' }, 'id1')
			expect(mockApplyEdits).toHaveBeenCalledWith([{ type: 'delete', filePath: 'old.ts' }])
			expect(result.content).toContain('Deleted old.ts')
		})

		it('returns error on failure', async () => {
			mockApplyEdits.mockRejectedValueOnce(new Error('ENOENT: no such file'))
			const result = await handleTool('delete_file', { filePath: 'nope.ts' }, 'id1')
			expect(result.is_error).toBe(true)
		})
	})

	describe('done', () => {
		it('returns completion message', async () => {
			const result = await handleTool('done', { summary: 'All changes applied' }, 'id1')
			expect(result.content).toBe('Implementation complete.')
		})
	})

	it('returns error for unknown tool', async () => {
		const result = await handleTool('nonexistent_tool', {}, 'id1')
		expect(result.is_error).toBe(true)
		expect(result.content).toContain('Unknown tool: nonexistent_tool')
	})
})
