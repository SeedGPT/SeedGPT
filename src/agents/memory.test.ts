import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		planModel: 'claude-haiku-4-5',
		memory: {
			tokenBudget: 10000,
			fullReflections: 5,
			summarizedReflections: 20,
			estimationRatio: 4,
		},
	},
}))

const mockCallApi = jest.fn<() => Promise<{ content: Array<{ type: string, text: string }>; usage: { input_tokens: number; output_tokens: number } }>>()
	.mockResolvedValue({ content: [{ type: 'text', text: 'mock summary' }], usage: { input_tokens: 10, output_tokens: 5 } })

jest.unstable_mockModule('../llm/api.js', () => ({
	callApi: mockCallApi,
	callBatchApi: jest.fn(),
}))

const memory = await import('./memory.js')
const MemoryModel = (await import('../models/Memory.js')).default

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
	describe('storeNote', () => {
		it('creates a note and returns confirmation', async () => {
			const result = await memory.storeNote('Goal: add test coverage')

			expect(result).toContain('Note saved')
			expect(result).toContain('mock summary')

			const memories = await MemoryModel.find({ category: 'note' })
			expect(memories).toHaveLength(1)
			expect(memories[0].content).toBe('Goal: add test coverage')
			expect(memories[0].active).toBe(true)
		})
	})

	describe('dismissNote', () => {
		it('dismisses an existing note', async () => {
			const result = await memory.storeNote('Some goal')
			const id = result.match(/\(([a-f0-9]+)\)/)?.[1]

			const dismissResult = await memory.dismissNote(id!)
			expect(dismissResult).toContain('Note dismissed')

			const doc = await MemoryModel.findById(id)
			expect(doc!.active).toBe(false)
		})

		it('returns error for non-existent id', async () => {
			const fakeId = new mongoose.Types.ObjectId().toString()
			const result = await memory.dismissNote(fakeId)
			expect(result).toContain('No note found')
		})

		it('returns error for non-note memory', async () => {
			await memory.storeReflection('just a reflection')
			const doc = await MemoryModel.findOne({ category: 'reflection' })

			const result = await memory.dismissNote(doc!._id.toString())
			expect(result).toContain('not a note')
		})
	})

	describe('storeReflection', () => {
		it('creates a reflection memory', async () => {
			await memory.storeReflection('I should focus more on testing')

			const memories = await MemoryModel.find({ category: 'reflection' })
			expect(memories).toHaveLength(1)
			expect(memories[0].content).toBe('I should focus more on testing')
			expect(memories[0].summary).toBe('mock summary')
		})
	})

	describe('getMemoryContext', () => {
		it('returns first-run message when no memories exist', async () => {
			const context = await memory.getMemoryContext()
			expect(context).toBe('No memories yet.')
		})

		it('includes active notes in "Notes to self" section', async () => {
			await memory.storeNote('Goal: become self-aware')

			const context = await memory.getMemoryContext()
			expect(context).toContain('## Notes to self')
			expect(context).toContain('mock summary')
		})

		it('includes reflections in "Recent Reflections" section', async () => {
			await memory.storeReflection('I need to be more careful')

			const context = await memory.getMemoryContext()
			expect(context).toContain('## Recent Reflections')
		})

		it('shows both sections when both types exist', async () => {
			await memory.storeNote('Goal: add HTTP')
			await memory.storeReflection('Good progress today')

			const context = await memory.getMemoryContext()
			expect(context).toContain('## Notes to self')
			expect(context).toContain('## Recent Reflections')
		})

		it('lists notes newest-first', async () => {
			await MemoryModel.create({ content: 'old', summary: 'OLD_NOTE', category: 'note', active: true, createdAt: new Date('2025-01-01') })
			await MemoryModel.create({ content: 'new', summary: 'NEW_NOTE', category: 'note', active: true, createdAt: new Date('2025-06-01') })

			const context = await memory.getMemoryContext()
			const oldIdx = context.indexOf('OLD_NOTE')
			const newIdx = context.indexOf('NEW_NOTE')
			expect(newIdx).toBeLessThan(oldIdx)
		})

		it('shows full content for recent reflections and summaries for older ones', async () => {
			for (let i = 0; i < 10; i++) {
				await MemoryModel.create({
					content: `Full reflection content ${i}`,
					summary: `Summary ${i}`,
					category: 'reflection',
					createdAt: new Date(Date.now() - (10 - i) * 60000),
				})
			}

			const context = await memory.getMemoryContext()
			const lines = context.split('\n').filter(l => l.startsWith('- ('))
			const fullLines = lines.filter(l => l.includes('Full reflection content'))
			const summaryLines = lines.filter(l => l.includes('Summary ') && !l.includes('Full reflection content'))
			expect(fullLines.length).toBe(5)
			expect(summaryLines.length).toBe(5)
		})

		it('respects token budget by limiting reflections', async () => {
			const { config } = await import('../config.js');
			(config as { memory: { tokenBudget: number } }).memory.tokenBudget = 100

			for (let i = 0; i < 50; i++) {
				await MemoryModel.create({
					content: `Reflection ${i} with some longer content to take up tokens`,
					summary: `Summary of reflection number ${i} that is reasonably long`,
					category: 'reflection',
				})
			}

			const context = await memory.getMemoryContext()
			const lines = context.split('\n').filter(l => l.startsWith('- ('))
			expect(lines.length).toBeLessThan(50);

			(config as { memory: { tokenBudget: number } }).memory.tokenBudget = 10000
		})
	})

	describe('recall', () => {
		it('finds memories by keyword using regex fallback', async () => {
			await MemoryModel.create({ content: 'Added HTTP client for web access', summary: 'HTTP client', category: 'reflection' })
			await MemoryModel.create({ content: 'Fixed a bug in the loop', summary: 'Bug fix', category: 'reflection' })

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
				category: 'reflection',
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

	describe('listIterations', () => {
		const IterationLogModel = (await import('../models/IterationLog.js')).default

		beforeEach(async () => {
			await IterationLogModel.deleteMany({})
		})

		it('returns formatted list when iterations exist', async () => {
			await IterationLogModel.create({
				entries: [
					{ timestamp: '2025-01-01T12:00:00Z', level: 'info', message: 'Build phase started' },
					{ timestamp: '2025-01-01T12:05:00Z', level: 'info', message: 'Merged PR #123 successfully' },
				],
				createdAt: new Date('2025-01-01T12:00:00Z'),
			})

			await IterationLogModel.create({
				entries: [
					{ timestamp: '2025-01-02T10:00:00Z', level: 'info', message: 'Started new iteration' },
					{ timestamp: '2025-01-02T10:30:00Z', level: 'error', message: 'Max turns reached, giving up' },
				],
				createdAt: new Date('2025-01-02T10:00:00Z'),
			})

			await IterationLogModel.create({
				entries: [
					{ timestamp: '2025-01-03T08:00:00Z', level: 'info', message: 'Iteration started' },
					{ timestamp: '2025-01-03T08:45:00Z', level: 'error', message: 'CI failed after 3 attempts' },
				],
				createdAt: new Date('2025-01-03T08:00:00Z'),
			})

			const result = await memory.listIterations(10)

			// Should return newest first (descending by createdAt)
			expect(result).toContain('2025-01-03')
			expect(result).toContain('2025-01-02')
			expect(result).toContain('2025-01-01')

			// Should detect different outcomes
			expect(result).toContain('success')
			expect(result).toContain('failure')
		})

		it('respects the limit parameter', async () => {
			// Create 15 iterations
			for (let i = 0; i < 15; i++) {
				await IterationLogModel.create({
					entries: [{ timestamp: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, level: 'info', message: 'Test' }],
					createdAt: new Date(`2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
				})
			}

			const result = await memory.listIterations(5)
			const lines = result.split('\n').filter(l => l.trim().length > 0)
			expect(lines.length).toBe(5)
		})

		it('returns "No iterations found" when database is empty', async () => {
			const result = await memory.listIterations(10)
			expect(result).toBe('No iterations found in database.')
		})

		it('uses default limit of 10 when not provided', async () => {
			for (let i = 0; i < 15; i++) {
				await IterationLogModel.create({
					entries: [{ timestamp: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, level: 'info', message: 'Test' }],
					createdAt: new Date(`2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
				})
			}

			const result = await memory.listIterations()
			const lines = result.split('\n').filter(l => l.trim().length > 0)
			expect(lines.length).toBe(10)
		})
	})
})
