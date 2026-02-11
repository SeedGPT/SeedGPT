import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

jest.unstable_mockModule('./config.js', () => ({
	config: {
		planModel: 'claude-haiku-4-5',
		memoryTokenBudget: 10000,
	},
}))

const mockCallApi = jest.fn<() => Promise<{ content: Array<{ type: string, text: string }>; usage: { input_tokens: number; output_tokens: number } }>>()
	.mockResolvedValue({ content: [{ type: 'text', text: 'mock summary' }], usage: { input_tokens: 10, output_tokens: 5 } })

jest.unstable_mockModule('./api.js', () => ({
	callApi: mockCallApi,
}))

const memory = await import('./memory.js')
const MemoryModel = (await import('./models/Memory.js')).default

let replSet: MongoMemoryReplSet

beforeAll(async () => {
	replSet = new MongoMemoryReplSet()
	await replSet.start()
	await replSet.waitUntilRunning()
	await mongoose.connect(replSet.getUri())
}, 30000)

afterAll(async () => {
	await mongoose.disconnect()
	await replSet.stop({ doCleanup: true, force: true })
})

beforeEach(async () => {
	await MemoryModel.deleteMany({})
	jest.clearAllMocks()
})

describe('memory', () => {
	describe('store', () => {
		it('creates an unpinned memory with a summary', async () => {
			await memory.storePastMemory('Built a new feature for HTTP requests')

			const memories = await MemoryModel.find({})
			expect(memories).toHaveLength(1)
			expect(memories[0].content).toBe('Built a new feature for HTTP requests')
			expect(memories[0].summary).toBe('mock summary')
			expect(memories[0].pinned).toBe(false)
		})
	})

	describe('pin', () => {
		it('creates a pinned memory and returns confirmation', async () => {
			const result = await memory.storePinnedMemory('Goal: add test coverage')

			expect(result).toContain('Note saved')
			expect(result).toContain('mock summary')

			const memories = await MemoryModel.find({ pinned: true })
			expect(memories).toHaveLength(1)
			expect(memories[0].content).toBe('Goal: add test coverage')
		})
	})

	describe('unpin', () => {
		it('unpins an existing pinned note', async () => {
			const result = await memory.storePinnedMemory('Some goal')
			const id = result.match(/\(([a-f0-9]+)\)/)?.[1]

			const unpinResult = await memory.unpinMemory(id!)
			expect(unpinResult).toContain('Note dismissed')

			const doc = await MemoryModel.findById(id)
			expect(doc!.pinned).toBe(false)
		})

		it('returns error for non-existent id', async () => {
			const fakeId = new mongoose.Types.ObjectId().toString()
			const result = await memory.unpinMemory(fakeId)
			expect(result).toContain('No note found')
		})

		it('returns error for unpinned memory', async () => {
			await memory.storePastMemory('not pinned')
			const doc = await MemoryModel.findOne({ pinned: false })

			const result = await memory.unpinMemory(doc!._id.toString())
			expect(result).toContain('not a note')
		})
	})

	describe('getContext', () => {
		it('returns first-run message when no memories exist', async () => {
			const context = await memory.getContext()
			expect(context).toBe('No memories yet. This is your first run.')
		})

		it('includes pinned notes in "Notes to self" section', async () => {
			await memory.storePinnedMemory('Goal: become self-aware')

			const context = await memory.getContext()
			expect(context).toContain('## Notes to self')
			expect(context).toContain('mock summary')
		})

		it('includes unpinned memories in "Past" section', async () => {
			await memory.storePastMemory('Merged PR #1')

			const context = await memory.getContext()
			expect(context).toContain('## Past')
			expect(context).toContain('mock summary')
		})

		it('shows both sections when both types exist', async () => {
			await memory.storePinnedMemory('Goal: add HTTP')
			await memory.storePastMemory('Merged PR #1')

			const context = await memory.getContext()
			expect(context).toContain('## Notes to self')
			expect(context).toContain('## Past')
		})

		it('respects token budget by limiting past memories', async () => {
			const { config } = await import('./config.js');
			(config as { memoryTokenBudget: number }).memoryTokenBudget = 100

			for (let i = 0; i < 50; i++) {
				await MemoryModel.create({
					content: `Memory ${i} with some longer content to take up tokens`,
					summary: `Summary of memory number ${i} that is reasonably long`,
					pinned: false,
				})
			}

			const context = await memory.getContext()
			const lines = context.split('\n').filter(l => l.startsWith('- ('))
			expect(lines.length).toBeLessThan(50);

			(config as { memoryTokenBudget: number }).memoryTokenBudget = 10000
		})
	})

	describe('recall', () => {
		it('finds memories by keyword using regex fallback', async () => {
			await MemoryModel.create({ content: 'Added HTTP client for web access', summary: 'HTTP client', pinned: false })
			await MemoryModel.create({ content: 'Fixed a bug in the loop', summary: 'Bug fix', pinned: false })

			const result = await memory.recall('HTTP')
			expect(result).toContain('HTTP client for web access')
			expect(result).not.toContain('bug in the loop')
		})

		it('returns message when no matches found', async () => {
			const result = await memory.recall('nonexistent-query-xyz')
			expect(result).toContain('No memories matching')
		})
	})

	describe('recallById', () => {
		it('retrieves a specific memory by id', async () => {
			const doc = await MemoryModel.create({
				content: 'Specific memory content',
				summary: 'specific',
				pinned: false,
			})

			const result = await memory.recallById(doc._id.toString())
			expect(result).toContain('Specific memory content')
		})

		it('returns error for invalid id', async () => {
			const fakeId = new mongoose.Types.ObjectId().toString()
			const result = await memory.recallById(fakeId)
			expect(result).toContain('No memory with id')
		})
	})

	describe('getFailureSummary', () => {
		it('returns empty string when no memories exist', async () => {
			const result = await memory.getFailureSummary()
			expect(result).toBe('')
		})

		it('returns empty string when no failures exist', async () => {
			await MemoryModel.create({ content: 'Successful PR merge', summary: 'Merged PR #1 successfully', pinned: false })
			await MemoryModel.create({ content: 'Added new feature', summary: 'New feature added', pinned: false })

			const result = await memory.getFailureSummary()
			expect(result).toBe('')
		})

		it('returns failure summaries when failures exist', async () => {
			await MemoryModel.create({ 
				content: 'PR closed due to CI failure', 
				summary: 'CI failed on PR #5 with exit code 1', 
				pinned: false 
			})
			await MemoryModel.create({ 
				content: 'Test error occurred', 
				summary: 'Test suite failing with import errors', 
				pinned: false 
			})

			const result = await memory.getFailureSummary()
			expect(result).toContain('CI failed on PR #5 with exit code 1')
			expect(result).toContain('Test suite failing with import errors')
		})

		it('limits results to 5 most recent failures', async () => {
			// Create 7 failures
			for (let i = 0; i < 7; i++) {
				await MemoryModel.create({
					content: `Failure ${i}`,
					summary: `Error ${i}: test failed`,
					pinned: false,
				})
			}

			const result = await memory.getFailureSummary()
			const lines = result.split('\n')
			expect(lines.length).toBe(5)
		})

		it('ignores pinned memories', async () => {
			await MemoryModel.create({ 
				content: 'Note: avoid doing X because it failed', 
				summary: 'Reminder about failed approach', 
				pinned: true 
			})
			await MemoryModel.create({ 
				content: 'Test failed in CI', 
				summary: 'CI test failure on PR #3', 
				pinned: false 
			})

			const result = await memory.getFailureSummary()
			expect(result).toContain('CI test failure on PR #3')
			expect(result).not.toContain('Reminder about failed approach')
		})

		it('detects various failure keywords', async () => {
			await MemoryModel.create({ content: 'Build closed', summary: 'PR closed after failure', pinned: false })
			await MemoryModel.create({ content: 'Got error message', summary: 'Error in compilation', pinned: false })
			await MemoryModel.create({ content: 'CI failed', summary: 'CI failing on tests', pinned: false })

			const result = await memory.getFailureSummary()
			expect(result).toContain('PR closed after failure')
			expect(result).toContain('Error in compilation')
			expect(result).toContain('CI failing on tests')
		})

		it('formats results as bullet list', async () => {
			await MemoryModel.create({ 
				content: 'Test failed', 
				summary: 'First failure summary', 
				pinned: false 
			})

			const result = await memory.getFailureSummary()
			expect(result).toMatch(/^- /)
		})
	})
})
