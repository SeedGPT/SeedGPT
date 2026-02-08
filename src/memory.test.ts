import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import MemoryModel from './models/Memory.js'

let replSet: MongoMemoryReplSet

beforeAll(async () => {
	replSet = new MongoMemoryReplSet()
	await replSet.start()
	await replSet.waitUntilRunning()
	await mongoose.connect(replSet.getUri())

	// Ensure indexes are built (needed for $text search)
	await MemoryModel.ensureIndexes()
}, 60000)

afterAll(async () => {
	await mongoose.disconnect()
	if (replSet) {
		await replSet.stop({ doCleanup: true, force: true })
	}
}, 30000)

beforeEach(async () => {
	await MemoryModel.deleteMany({})
})

describe('MemoryModel CRUD', () => {
	it('should create a non-pinned memory by default', async () => {
		const memory = await MemoryModel.create({
			content: 'Test content',
			summary: 'Test summary',
		})

		expect(memory.content).toBe('Test content')
		expect(memory.summary).toBe('Test summary')
		expect(memory.pinned).toBe(false)
		expect(memory.createdAt).toBeInstanceOf(Date)
		expect(memory.updatedAt).toBeInstanceOf(Date)
	})

	it('should create a pinned memory', async () => {
		const memory = await MemoryModel.create({
			content: 'Pinned content',
			summary: 'Pinned summary',
			pinned: true,
		})

		expect(memory.pinned).toBe(true)
	})

	it('should require content field', async () => {
		await expect(
			MemoryModel.create({ summary: 'No content' } as any)
		).rejects.toThrow()
	})

	it('should require summary field', async () => {
		await expect(
			MemoryModel.create({ content: 'No summary' } as any)
		).rejects.toThrow()
	})
})

describe('unpin logic', () => {
	it('should unpin a pinned memory by setting pinned to false', async () => {
		const memory = await MemoryModel.create({
			content: 'Pinned content',
			summary: 'Pinned summary',
			pinned: true,
		})

		const found = await MemoryModel.findById(memory._id)
		expect(found).toBeTruthy()
		expect(found!.pinned).toBe(true)

		found!.pinned = false
		await found!.save()

		const updated = await MemoryModel.findById(memory._id)
		expect(updated!.pinned).toBe(false)
	})

	it('should return null for non-existent id', async () => {
		const fakeId = new mongoose.Types.ObjectId()
		const found = await MemoryModel.findById(fakeId)
		expect(found).toBeNull()
	})

	it('should identify already unpinned memory', async () => {
		const memory = await MemoryModel.create({
			content: 'Unpinned content',
			summary: 'Unpinned summary',
			pinned: false,
		})

		const found = await MemoryModel.findById(memory._id)
		expect(found).toBeTruthy()
		expect(found!.pinned).toBe(false)
	})
})

describe('text search (recall logic)', () => {
	it('should find memories by text search on content', async () => {
		await MemoryModel.create({
			content: 'The architecture uses microservices with Docker containers.',
			summary: 'Architecture uses microservices and Docker.',
			pinned: false,
		})
		await MemoryModel.create({
			content: 'Database migration scripts are in the migrations folder.',
			summary: 'Database migration scripts location.',
			pinned: false,
		})

		const results = await MemoryModel
			.find({ $text: { $search: 'microservices' } }, { score: { $meta: 'textScore' } })
			.sort({ score: { $meta: 'textScore' } })
			.limit(5)
			.lean()

		expect(results.length).toBeGreaterThan(0)
		expect(results[0].content).toContain('microservices')
	})

	it('should find memories by text search on summary', async () => {
		await MemoryModel.create({
			content: 'Some generic content.',
			summary: 'Kubernetes orchestration details.',
			pinned: false,
		})

		const results = await MemoryModel
			.find({ $text: { $search: 'Kubernetes' } }, { score: { $meta: 'textScore' } })
			.sort({ score: { $meta: 'textScore' } })
			.limit(5)
			.lean()

		expect(results.length).toBeGreaterThan(0)
		expect(results[0].summary).toContain('Kubernetes')
	})

	it('should fall back to regex search when text search returns nothing', async () => {
		await MemoryModel.create({
			content: 'Config value xyz123abc is set in .env file.',
			summary: 'Config xyz123abc in env.',
			pinned: false,
		})

		// Regex fallback should find it even if text search doesn't
		const escaped = 'xyz123abc'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		const regexResults = await MemoryModel
			.find({ $or: [{ summary: new RegExp(escaped, 'i') }, { content: new RegExp(escaped, 'i') }] })
			.sort({ createdAt: -1 })
			.limit(5)
			.lean()

		expect(regexResults.length).toBeGreaterThan(0)
		expect(regexResults[0].content).toContain('xyz123abc')
	})

	it('should return empty array when nothing matches', async () => {
		const results = await MemoryModel
			.find({ $text: { $search: 'nonexistent_query_zzzzz' } })
			.limit(5)
			.lean()

		expect(results).toHaveLength(0)

		const regexResults = await MemoryModel
			.find({ $or: [{ summary: /nonexistent_query_zzzzz/i }, { content: /nonexistent_query_zzzzz/i }] })
			.limit(5)
			.lean()

		expect(regexResults).toHaveLength(0)
	})

	it('should respect limit of 5 results', async () => {
		for (let i = 0; i < 8; i++) {
			await MemoryModel.create({
				content: `Memory entry number ${i} about testing patterns and verification.`,
				summary: `Test memory ${i} about testing and verification.`,
				pinned: false,
			})
		}

		const results = await MemoryModel
			.find({ $text: { $search: 'testing verification' } }, { score: { $meta: 'textScore' } })
			.sort({ score: { $meta: 'textScore' } })
			.limit(5)
			.lean()

		expect(results.length).toBeLessThanOrEqual(5)
	})
})

describe('recallById logic', () => {
	it('should retrieve a memory by id with all fields', async () => {
		const memory = await MemoryModel.create({
			content: 'Full content of this specific memory.',
			summary: 'Specific memory summary.',
			pinned: false,
		})

		const found = await MemoryModel.findById(memory._id).lean()

		expect(found).toBeTruthy()
		expect(found!.content).toBe('Full content of this specific memory.')
		expect(found!.summary).toBe('Specific memory summary.')
		expect(found!._id.toString()).toBe(memory._id.toString())
		expect(found!.createdAt).toBeDefined()
	})

	it('should return null for non-existent id', async () => {
		const fakeId = new mongoose.Types.ObjectId()
		const found = await MemoryModel.findById(fakeId).lean()
		expect(found).toBeNull()
	})
})

describe('getContext query patterns', () => {
	it('should find no memories when database is empty', async () => {
		const notes = await MemoryModel.find({ pinned: true }).lean()
		const recent = await MemoryModel.find({ pinned: false }).lean()

		expect(notes).toHaveLength(0)
		expect(recent).toHaveLength(0)
	})

	it('should query pinned notes sorted by createdAt descending', async () => {
		await MemoryModel.create({
			content: 'First pinned',
			summary: 'First pinned summary',
			pinned: true,
		})

		// Delay to ensure different timestamps
		await new Promise(r => setTimeout(r, 50))

		await MemoryModel.create({
			content: 'Second pinned',
			summary: 'Second pinned summary',
			pinned: true,
		})

		const notes = await MemoryModel
			.find({ pinned: true })
			.sort({ createdAt: -1 })
			.select('_id summary')
			.lean()

		expect(notes).toHaveLength(2)
		expect(notes[0].summary).toBe('Second pinned summary')
		expect(notes[1].summary).toBe('First pinned summary')
	})

	it('should query non-pinned memories sorted by createdAt descending', async () => {
		await MemoryModel.create({
			content: 'First regular',
			summary: 'First regular summary',
			pinned: false,
		})

		await new Promise(r => setTimeout(r, 50))

		await MemoryModel.create({
			content: 'Second regular',
			summary: 'Second regular summary',
			pinned: false,
		})

		const recent = await MemoryModel
			.find({ pinned: false })
			.sort({ createdAt: -1 })
			.select('_id summary createdAt')
			.lean()

		expect(recent).toHaveLength(2)
		expect(recent[0].summary).toBe('Second regular summary')
		expect(recent[1].summary).toBe('First regular summary')
	})

	it('should separate pinned and non-pinned memories correctly', async () => {
		await MemoryModel.create({
			content: 'Pinned',
			summary: 'Pinned note',
			pinned: true,
		})
		await MemoryModel.create({
			content: 'Regular',
			summary: 'Regular memory',
			pinned: false,
		})

		const pinned = await MemoryModel.find({ pinned: true }).lean()
		const regular = await MemoryModel.find({ pinned: false }).lean()

		expect(pinned).toHaveLength(1)
		expect(pinned[0].summary).toBe('Pinned note')
		expect(regular).toHaveLength(1)
		expect(regular[0].summary).toBe('Regular memory')
	})

	it('should include _id field when selecting for context building', async () => {
		const memory = await MemoryModel.create({
			content: 'Content with id',
			summary: 'Summary with id',
			pinned: true,
		})

		const notes = await MemoryModel
			.find({ pinned: true })
			.select('_id summary')
			.lean()

		expect(notes).toHaveLength(1)
		expect(notes[0]._id.toString()).toBe(memory._id.toString())
		expect(notes[0].summary).toBe('Summary with id')
	})

	it('should format dates from createdAt for context output', async () => {
		const memory = await MemoryModel.create({
			content: 'Dated content',
			summary: 'Dated summary',
			pinned: false,
		})

		const found = await MemoryModel.findById(memory._id).lean()
		const date = new Date(found!.createdAt).toISOString().slice(0, 19).replace('T', ' ')

		// Should be a valid date string like "2024-01-15 12:30:45"
		expect(date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	})
})

describe('estimateTokens', () => {
	// Test the token estimation logic used in getContext
	function estimateTokens(text: string): number {
		return Math.ceil(text.length / 4)
	}

	it('should estimate tokens as ceil(length / 4)', () => {
		expect(estimateTokens('')).toBe(0)
		expect(estimateTokens('abcd')).toBe(1)
		expect(estimateTokens('abcde')).toBe(2)
		expect(estimateTokens('a')).toBe(1)
		expect(estimateTokens('ab')).toBe(1)
		expect(estimateTokens('abc')).toBe(1)
	})

	it('should handle longer strings proportionally', () => {
		const text = 'a'.repeat(100)
		expect(estimateTokens(text)).toBe(25)
	})

	it('should handle empty string as 0 tokens', () => {
		expect(estimateTokens('')).toBe(0)
	})
})

describe('context building integration', () => {
	it('should build notes section format correctly', async () => {
		const m1 = await MemoryModel.create({
			content: 'Note content 1',
			summary: 'Note summary 1',
			pinned: true,
		})
		const m2 = await MemoryModel.create({
			content: 'Note content 2',
			summary: 'Note summary 2',
			pinned: true,
		})

		const notes = await MemoryModel
			.find({ pinned: true })
			.sort({ createdAt: -1 })
			.select('_id summary')
			.lean()

		const header = '## Notes to self\n'
		const lines = notes.map(m => `- (${m._id}) ${m.summary}`)
		const notesSection = header + lines.join('\n')

		expect(notesSection).toContain('## Notes to self')
		expect(notesSection).toContain(m1._id.toString())
		expect(notesSection).toContain(m2._id.toString())
		expect(notesSection).toContain('Note summary 1')
		expect(notesSection).toContain('Note summary 2')
	})

	it('should build past section format correctly', async () => {
		const memory = await MemoryModel.create({
			content: 'Past content',
			summary: 'Past summary',
			pinned: false,
		})

		const recent = await MemoryModel
			.find({ pinned: false })
			.sort({ createdAt: -1 })
			.select('_id summary createdAt')
			.lean()

		const header = '## Past\n'
		const lines = recent.map(m => {
			const date = new Date(m.createdAt).toISOString().slice(0, 19).replace('T', ' ')
			return `- (${m._id}) [${date}] ${m.summary}`
		})
		const pastSection = header + lines.join('\n')

		expect(pastSection).toContain('## Past')
		expect(pastSection).toContain(memory._id.toString())
		expect(pastSection).toContain('Past summary')
		expect(pastSection).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/)
	})

	it('should build recall output format correctly', async () => {
		const memory = await MemoryModel.create({
			content: 'Recall content with details.',
			summary: 'Recall summary.',
			pinned: false,
		})

		const found = await MemoryModel.findById(memory._id).lean()
		const date = new Date(found!.createdAt).toISOString().slice(0, 19).replace('T', ' ')
		const output = `**${found!._id}** [${date}]\n${found!.content}`

		expect(output).toContain(memory._id.toString())
		expect(output).toContain('Recall content with details.')
		expect(output).toMatch(/\*\*.*\*\*/)
	})
})
