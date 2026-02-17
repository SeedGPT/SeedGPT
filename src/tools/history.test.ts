import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

const { queryIterationHistory } = await import('./history.js')
const GeneratedModel = (await import('../models/Generated.js')).default

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
	await GeneratedModel.deleteMany({})
})

describe('queryIterationHistory', () => {
	it('returns formatted summary for multiple iterations', async () => {
		// Create test data for multiple iterations
		const now = new Date()
		const iteration1Id = 'iter-001-abc'
		const iteration2Id = 'iter-002-def'

		// First iteration - completed (has reflect phase)
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'test-model',
			iterationId: iteration1Id,
			system: [],
			messages: [
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							name: 'submit_plan',
							input: { title: 'Add feature X' },
						},
					],
				},
			],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 2000),
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'test-model',
			iterationId: iteration1Id,
			system: [],
			messages: [],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 1500),
		})

		await GeneratedModel.create({
			phase: 'reflect',
			modelId: 'test-model',
			iterationId: iteration1Id,
			system: [],
			messages: [],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 1000),
		})

		// Second iteration - failed (no reflect phase)
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'test-model',
			iterationId: iteration2Id,
			system: [],
			messages: [
				{
					role: 'user',
					content: 'Fix the bug in module Y',
				},
			],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 500),
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'test-model',
			iterationId: iteration2Id,
			system: [],
			messages: [],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: now,
		})

		const result = await queryIterationHistory(10)

		expect(result).toContain('iter-002')
		expect(result).toContain('failed')
		expect(result).toContain('iter-001')
		expect(result).toContain('completed')
		expect(result).toContain('Add feature X')
		
		// Most recent should come first
		const lines = result.split('\n')
		expect(lines[0]).toContain('iter-002')
		expect(lines[1]).toContain('iter-001')
	})

	it('handles custom limit parameter', async () => {
		const now = new Date()

		// Create 3 iterations
		for (let i = 0; i < 3; i++) {
			await GeneratedModel.create({
				phase: 'planner',
				modelId: 'test-model',
				iterationId: `iter-${i}`,
				system: [],
				messages: [],
				response: [],
				inputTokens: 100,
				outputTokens: 50,
				cost: 0.01,
				batch: false,
				stopReason: 'end_turn',
				createdAt: new Date(now.getTime() - (3 - i) * 1000),
			})
		}

		// Request only 2
		const result = await queryIterationHistory(2)
		const lines = result.split('\n')
		expect(lines.length).toBe(2)
	})

	it('returns appropriate message when no history exists', async () => {
		const result = await queryIterationHistory()
		expect(result).toBe('No iteration history found.')
	})

	it('correctly identifies completed vs incomplete iterations', async () => {
		const now = new Date()

		// Complete iteration with reflect phase
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'test-model',
			iterationId: 'complete-iter',
			system: [],
			messages: [],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 2000),
		})

		await GeneratedModel.create({
			phase: 'reflect',
			modelId: 'test-model',
			iterationId: 'complete-iter',
			system: [],
			messages: [],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 1000),
		})

		// Incomplete iteration without reflect phase
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'test-model',
			iterationId: 'incomplete-iter',
			system: [],
			messages: [],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: now,
		})

		const result = await queryIterationHistory()
		const lines = result.split('\n')

		const completeLine = lines.find(l => l.includes('complete-iter ['))
		const incompleteLine = lines.find(l => l.includes('incomplete-iter ['))

		expect(completeLine).toContain('completed')
		expect(incompleteLine).toContain('failed')
	})

	it('extracts description from various message formats', async () => {
		const now = new Date()

		// Test with tool_use format
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'test-model',
			iterationId: 'iter-tool',
			system: [],
			messages: [
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							name: 'submit_plan',
							input: { title: 'Implement authentication' },
						},
					],
				},
			],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 3000),
		})

		// Test with text block format
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'test-model',
			iterationId: 'iter-text',
			system: [],
			messages: [
				{
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Refactor database connection',
						},
					],
				},
			],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 2000),
		})

		// Test with string format
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'test-model',
			iterationId: 'iter-string',
			system: [],
			messages: [
				{
					role: 'user',
					content: 'Fix memory leak in worker',
				},
			],
			response: [],
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date(now.getTime() - 1000),
		})

		const result = await queryIterationHistory(10)

		expect(result).toContain('Implement authentication')
		expect(result).toContain('Refactor database connection')
		expect(result).toContain('Fix memory leak in worker')
	})
})
