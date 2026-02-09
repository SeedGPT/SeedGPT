import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import GeneratedModel from './models/Generated.js'
import UsageModel from './models/Usage.js'
import * as analytics from './analytics.js'

let replSet: MongoMemoryReplSet

beforeAll(async () => {
	replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
	await mongoose.connect(replSet.getUri())
})

afterAll(async () => {
	await mongoose.disconnect()
	await replSet.stop()
})

describe('analytics', () => {
	beforeEach(async () => {
		await GeneratedModel.deleteMany({})
		await UsageModel.deleteMany({})
	})

	describe('queryIterations', () => {
		it('returns formatted iterations', async () => {
			await GeneratedModel.create({
				planTitle: 'test-change',
				outcome: 'PR #1 merged successfully after 1 attempt(s).',
				plannerTranscript: 'planning...',
				builderTranscript: 'building...',
				reflection: 'It worked well.',
			})

			const result = await analytics.queryIterations(10)
			expect(result).toContain('test-change')
			expect(result).toContain('merged successfully')
			expect(result).toContain('It worked well')
		})

		it('filters by success outcome', async () => {
			await GeneratedModel.create({
				planTitle: 'success-change',
				outcome: 'PR #1 merged successfully',
				plannerTranscript: 'p1',
				builderTranscript: 'b1',
				reflection: 'good',
			})
			await GeneratedModel.create({
				planTitle: 'failure-change',
				outcome: 'Failed after 4 attempts',
				plannerTranscript: 'p2',
				builderTranscript: 'b2',
				reflection: 'bad',
			})

			const result = await analytics.queryIterations(10, 'success')
			expect(result).toContain('success-change')
			expect(result).not.toContain('failure-change')
		})

		it('filters by failure outcome', async () => {
			await GeneratedModel.create({
				planTitle: 'success-change',
				outcome: 'merged successfully',
				plannerTranscript: 'p1',
				builderTranscript: 'b1',
				reflection: 'good',
			})
			await GeneratedModel.create({
				planTitle: 'failure-change',
				outcome: 'Failed after 4 attempts',
				plannerTranscript: 'p2',
				builderTranscript: 'b2',
				reflection: 'bad',
			})

			const result = await analytics.queryIterations(10, 'failure')
			expect(result).toContain('failure-change')
			expect(result).not.toContain('success-change')
		})

		it('returns empty message when no results', async () => {
			const result = await analytics.queryIterations(10)
			expect(result).toBe('No iterations found matching the criteria.')
		})
	})

	describe('queryUsageTrends', () => {
		it('returns summary and entries', async () => {
			await UsageModel.create({
				planTitle: 'test-1',
				totalCalls: 5,
				totalInputTokens: 1000,
				totalOutputTokens: 500,
				totalCost: 0.05,
				breakdown: [{ caller: 'planner', model: 'claude-haiku-4-5', calls: 3, inputTokens: 600, outputTokens: 300, cost: 0.03 }],
			})

			const result = await analytics.queryUsageTrends(10)
			expect(result).toContain('Summary')
			expect(result).toContain('Total cost: $0.050')
			expect(result).toContain('test-1')
			expect(result).toContain('1500 tokens')
		})

		it('returns empty message when no data', async () => {
			const result = await analytics.queryUsageTrends(10)
			expect(result).toBe('No usage data available.')
		})
	})

	describe('searchReflections', () => {
		it('finds reflections by keyword', async () => {
			await GeneratedModel.create({
				planTitle: 'test-1',
				outcome: 'success',
				plannerTranscript: 'p',
				builderTranscript: 'b',
				reflection: 'The change was too ambitious and broke tests.',
			})
			await GeneratedModel.create({
				planTitle: 'test-2',
				outcome: 'success',
				plannerTranscript: 'p',
				builderTranscript: 'b',
				reflection: 'Simple refactor went smoothly.',
			})

			const result = await analytics.searchReflections('ambitious', 5)
			expect(result).toContain('test-1')
			expect(result).toContain('too ambitious')
			expect(result).not.toContain('test-2')
		})

		it('returns empty message when no matches', async () => {
			const result = await analytics.searchReflections('nonexistent', 5)
			expect(result).toContain('No reflections matching')
		})
	})
})
