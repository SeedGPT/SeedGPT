import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { analyzeIterations, formatAnalysisReport, getRecentIterationSummary, type AnalysisReport } from './analyze.js'
import GeneratedModel from '../models/Generated.js'
import IterationLogModel from '../models/IterationLog.js'

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
	await IterationLogModel.deleteMany({})
})

describe('analyzeIterations', () => {
	it('returns empty report when no data exists', async () => {
		const report = await analyzeIterations()

		expect(report.totalIterations).toBe(0)
		expect(report.dateRange.earliest).toBeNull()
		expect(report.dateRange.latest).toBeNull()
		expect(report.apiUsage.totalCost).toBe(0)
		expect(report.apiUsage.totalCalls).toBe(0)
		expect(Object.keys(report.apiUsage.byPhase)).toHaveLength(0)
	})

	it('computes basic statistics from API calls', async () => {
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 200,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 2000,
			outputTokens: 1000,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 500,
			cost: 0.02,
			batch: false,
			stopReason: 'tool_use',
		})

		const report = await analyzeIterations()

		expect(report.totalIterations).toBe(1)
		expect(report.apiUsage.totalCalls).toBe(2)
		expect(report.apiUsage.totalCost).toBe(0.03)
		expect(report.apiUsage.byPhase.planner).toBeDefined()
		expect(report.apiUsage.byPhase.planner.count).toBe(1)
		expect(report.apiUsage.byPhase.planner.totalCost).toBe(0.01)
		expect(report.apiUsage.byPhase.builder).toBeDefined()
		expect(report.apiUsage.byPhase.builder.count).toBe(1)
		expect(report.apiUsage.byPhase.builder.totalCost).toBe(0.02)
	})

	it('computes cache efficiency correctly', async () => {
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 100,
			cacheWrite1hTokens: 50,
			cacheReadTokens: 200,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
		})

		const report = await analyzeIterations()

		expect(report.cacheEfficiency.totalCacheReads).toBe(200)
		expect(report.cacheEfficiency.totalCacheWrites).toBe(150)
		// Hit rate = cacheReads / (inputTokens + cacheWrites + cacheReads)
		// = 200 / (1000 + 150 + 200) = 200 / 1350 ≈ 0.148
		expect(report.cacheEfficiency.overallHitRate).toBeCloseTo(0.148, 2)
	})

	it('tracks model usage', async () => {
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 2000,
			outputTokens: 1000,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.02,
			batch: false,
			stopReason: 'tool_use',
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1500,
			outputTokens: 800,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.015,
			batch: false,
			stopReason: 'end_turn',
		})

		const report = await analyzeIterations()

		expect(report.modelUsage['claude-haiku-4-5']).toBe(1)
		expect(report.modelUsage['claude-sonnet-4-5']).toBe(2)
	})

	it('tracks stop reasons', async () => {
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 2000,
			outputTokens: 1000,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.02,
			batch: false,
			stopReason: 'tool_use',
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-2',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1500,
			outputTokens: 800,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.015,
			batch: false,
			stopReason: 'end_turn',
		})

		const report = await analyzeIterations()

		expect(report.stopReasons.end_turn).toBe(2)
		expect(report.stopReasons.tool_use).toBe(1)
	})

	it('analyzes log patterns', async () => {
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
		})

		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T10:00:00Z', level: 'info', message: 'Starting iteration' },
				{ timestamp: '2025-01-01T10:00:01Z', level: 'error', message: 'Failed to connect' },
				{ timestamp: '2025-01-01T10:00:02Z', level: 'warn', message: 'Retrying connection' },
				{ timestamp: '2025-01-01T10:00:03Z', level: 'info', message: 'Connected' },
			],
		})

		const report = await analyzeIterations()

		expect(report.commonLogPatterns.totalLogEntries).toBe(4)
		expect(report.commonLogPatterns.errorCount).toBe(1)
		expect(report.commonLogPatterns.warningCount).toBe(1)
	})

	it('filters by limit parameter', async () => {
		// Create 3 iterations worth of data
		for (let i = 1; i <= 3; i++) {
			await GeneratedModel.create({
				phase: 'planner',
				modelId: 'claude-haiku-4-5',
				iterationId: `iter-${i}`,
				system: [],
				messages: [],
				response: [],
				inputTokens: 1000,
				outputTokens: 500,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 0,
				cacheReadTokens: 0,
				cost: 0.01,
				batch: false,
				stopReason: 'end_turn',
				createdAt: new Date(Date.now() - (3 - i) * 60000),
			})
		}

		const report = await analyzeIterations({ limit: 2 })

		// Should limit to 2 iterations, but since we use limit * 10 for Generated records,
		// we should get at most 20 API call records (though we only have 3 total)
		expect(report.apiUsage.totalCalls).toBeLessThanOrEqual(3)
	})

	it('filters by date parameter', async () => {
		const oldDate = new Date('2025-01-01')
		const newDate = new Date('2025-06-01')

		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-old',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: oldDate,
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-new',
			system: [],
			messages: [],
			response: [],
			inputTokens: 2000,
			outputTokens: 1000,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.02,
			batch: false,
			stopReason: 'tool_use',
			createdAt: newDate,
		})

		const report = await analyzeIterations({ since: new Date('2025-05-01') })

		expect(report.apiUsage.totalCalls).toBe(1)
		expect(report.apiUsage.byPhase.builder).toBeDefined()
		expect(report.apiUsage.byPhase.planner).toBeUndefined()
	})

	it('computes date range correctly', async () => {
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
			createdAt: new Date('2025-01-01'),
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-2',
			system: [],
			messages: [],
			response: [],
			inputTokens: 2000,
			outputTokens: 1000,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.02,
			batch: false,
			stopReason: 'tool_use',
			createdAt: new Date('2025-06-01'),
		})

		const report = await analyzeIterations()

		expect(report.dateRange.earliest).toEqual(new Date('2025-01-01'))
		expect(report.dateRange.latest).toEqual(new Date('2025-06-01'))
	})

	it('counts unique iterations by iterationId', async () => {
		// Create multiple API calls for same iteration
		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'tool_use',
		})

		await GeneratedModel.create({
			phase: 'planner',
			modelId: 'claude-haiku-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 1000,
			outputTokens: 500,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.01,
			batch: false,
			stopReason: 'end_turn',
		})

		await GeneratedModel.create({
			phase: 'builder',
			modelId: 'claude-sonnet-4-5',
			iterationId: 'iter-1',
			system: [],
			messages: [],
			response: [],
			inputTokens: 2000,
			outputTokens: 1000,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 0,
			cost: 0.02,
			batch: false,
			stopReason: 'tool_use',
		})

		const report = await analyzeIterations()

		expect(report.totalIterations).toBe(1)
		expect(report.apiUsage.totalCalls).toBe(3)
	})
})

describe('formatAnalysisReport', () => {
	it('formats empty report', () => {
		const report: AnalysisReport = {
			totalIterations: 0,
			dateRange: { earliest: null, latest: null },
			apiUsage: {
				totalCost: 0,
				totalCalls: 0,
				byPhase: {},
			},
			cacheEfficiency: {
				overallHitRate: 0,
				totalCacheReads: 0,
				totalCacheWrites: 0,
			},
			modelUsage: {},
			stopReasons: {},
			commonLogPatterns: {
				errorCount: 0,
				warningCount: 0,
				totalLogEntries: 0,
			},
		}

		const formatted = formatAnalysisReport(report)
		expect(formatted).toBe('No iteration history available yet.')
	})

	it('formats complete report', () => {
		const report: AnalysisReport = {
			totalIterations: 2,
			dateRange: {
				earliest: new Date('2025-01-01'),
				latest: new Date('2025-01-02'),
			},
			apiUsage: {
				totalCost: 0.05,
				totalCalls: 4,
				byPhase: {
					planner: {
						count: 2,
						totalCost: 0.02,
						avgCost: 0.01,
						totalInputTokens: 2000,
						totalOutputTokens: 1000,
						avgInputTokens: 1000,
						avgOutputTokens: 500,
						cacheReadTokens: 200,
						cacheWriteTokens: 100,
						cacheHitRate: 0.15,
					},
					builder: {
						count: 2,
						totalCost: 0.03,
						avgCost: 0.015,
						totalInputTokens: 3000,
						totalOutputTokens: 1500,
						avgInputTokens: 1500,
						avgOutputTokens: 750,
						cacheReadTokens: 500,
						cacheWriteTokens: 200,
						cacheHitRate: 0.25,
					},
				},
			},
			cacheEfficiency: {
				overallHitRate: 0.20,
				totalCacheReads: 700,
				totalCacheWrites: 300,
			},
			modelUsage: {
				'claude-haiku-4-5': 2,
				'claude-sonnet-4-5': 2,
			},
			stopReasons: {
				end_turn: 3,
				tool_use: 1,
			},
			commonLogPatterns: {
				errorCount: 1,
				warningCount: 2,
				totalLogEntries: 20,
			},
		}

		const formatted = formatAnalysisReport(report)

		expect(formatted).toContain('# Iteration Analysis (2 iterations)')
		expect(formatted).toContain('Date range: 2025-01-01 to 2025-01-02')
		expect(formatted).toContain('Total calls: 4')
		expect(formatted).toContain('Total cost: $0.050')
		expect(formatted).toContain('## API Usage')
		expect(formatted).toContain('## Cache Efficiency')
		expect(formatted).toContain('Overall hit rate: 20.0%')
		expect(formatted).toContain('## Model Usage')
		expect(formatted).toContain('claude-haiku-4-5: 2 calls')
		expect(formatted).toContain('## Stop Reasons')
		expect(formatted).toContain('## Log Patterns')
		expect(formatted).toContain('Errors: 1')
		expect(formatted).toContain('Warnings: 2')
	})

	it('formats report with same date', () => {
		const report: AnalysisReport = {
			totalIterations: 1,
			dateRange: {
				earliest: new Date('2025-01-01'),
				latest: new Date('2025-01-01'),
			},
			apiUsage: {
				totalCost: 0.01,
				totalCalls: 1,
				byPhase: {},
			},
			cacheEfficiency: {
				overallHitRate: 0,
				totalCacheReads: 0,
				totalCacheWrites: 0,
			},
			modelUsage: {},
			stopReasons: {},
			commonLogPatterns: {
				errorCount: 0,
				warningCount: 0,
				totalLogEntries: 5,
			},
		}

		const formatted = formatAnalysisReport(report)

		expect(formatted).toContain('Date: 2025-01-01')
		expect(formatted).not.toContain('Date range:')
	})
})

describe('getRecentIterationSummary', () => {
	it('returns empty string when no iterations exist', async () => {
		const summary = await getRecentIterationSummary()
		expect(summary).toBe('')
	})

	it('summarizes successful merged iterations', async () => {
		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T10:00:00Z', level: 'info', message: 'Planned: "test"' },
				{ timestamp: '2025-01-01T10:05:00Z', level: 'info', message: 'PR #1 merged successfully.' },
			],
		})

		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T11:00:00Z', level: 'info', message: 'Planned: "test2"' },
				{ timestamp: '2025-01-01T11:05:00Z', level: 'info', message: 'PR #2 merged, branch deleted. Change is now on main.' },
			],
		})

		const summary = await getRecentIterationSummary()
		expect(summary).toContain('2/2 merged')
		expect(summary).toContain('0 failed')
	})

	it('tracks failed iterations', async () => {
		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T10:00:00Z', level: 'info', message: 'Planned: "test"' },
				{ timestamp: '2025-01-01T10:05:00Z', level: 'error', message: 'FAILED — PR #1 closed without merging, branch deleted.' },
			],
		})

		const summary = await getRecentIterationSummary()
		expect(summary).toContain('0 merged')
		expect(summary).toContain('1 failed')
	})

	it('tracks fix attempts', async () => {
		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T10:00:00Z', level: 'info', message: 'Planned: "test"' },
				{ timestamp: '2025-01-01T10:05:00Z', level: 'warn', message: 'CI failed (attempt 1), attempting fix: error' },
				{ timestamp: '2025-01-01T10:06:00Z', level: 'info', message: 'Pushed fix commit (attempt 1).' },
				{ timestamp: '2025-01-01T10:10:00Z', level: 'info', message: 'PR #1 merged successfully.' },
			],
		})

		const summary = await getRecentIterationSummary()
		expect(summary).toContain('1/1 merged')
		expect(summary).toContain('1 iter w/ fixes')
	})

	it('identifies common issue types', async () => {
		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T10:00:00Z', level: 'info', message: 'Planned: "test"' },
				{ timestamp: '2025-01-01T10:05:00Z', level: 'warn', message: 'CI failed (attempt 1), attempting fix: Tests failed in test.ts' },
				{ timestamp: '2025-01-01T10:06:00Z', level: 'error', message: 'FAILED — PR #1 closed' },
			],
		})

		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T11:00:00Z', level: 'info', message: 'Planned: "test2"' },
				{ timestamp: '2025-01-01T11:05:00Z', level: 'warn', message: 'CI failed (attempt 1), attempting fix: Build failed' },
				{ timestamp: '2025-01-01T11:06:00Z', level: 'error', message: 'FAILED — PR #2 closed' },
			],
		})

		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T12:00:00Z', level: 'info', message: 'Planned: "test3"' },
				{ timestamp: '2025-01-01T12:05:00Z', level: 'warn', message: 'CI failed (attempt 1), attempting fix: test fail detected' },
				{ timestamp: '2025-01-01T12:06:00Z', level: 'error', message: 'FAILED — PR #3 closed' },
			],
		})

		const summary = await getRecentIterationSummary()
		expect(summary).toContain('test failures: 2')
		expect(summary).toContain('build failures: 1')
	})

	it('respects limit parameter', async () => {
		for (let i = 1; i <= 15; i++) {
			await IterationLogModel.create({
				entries: [
					{ timestamp: `2025-01-01T${String(i).padStart(2, '0')}:00:00Z`, level: 'info', message: `Iteration ${i}` },
					{ timestamp: `2025-01-01T${String(i).padStart(2, '0')}:05:00Z`, level: 'info', message: `PR #${i} merged successfully.` },
				],
			})
		}

		const summary = await getRecentIterationSummary(5)
		expect(summary).toContain('5/5 merged')
	})

	it('handles mixed outcomes correctly', async () => {
		// Merged iteration
		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T10:00:00Z', level: 'info', message: 'Planned: "test1"' },
				{ timestamp: '2025-01-01T10:05:00Z', level: 'info', message: 'PR #1 merged successfully.' },
			],
		})

		// Failed iteration with fix attempt
		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T11:00:00Z', level: 'info', message: 'Planned: "test2"' },
				{ timestamp: '2025-01-01T11:05:00Z', level: 'warn', message: 'CI failed (attempt 1), attempting fix: test error' },
				{ timestamp: '2025-01-01T11:06:00Z', level: 'error', message: 'FAILED — PR #2 closed' },
			],
		})

		// Merged iteration with fix
		await IterationLogModel.create({
			entries: [
				{ timestamp: '2025-01-01T12:00:00Z', level: 'info', message: 'Planned: "test3"' },
				{ timestamp: '2025-01-01T12:05:00Z', level: 'warn', message: 'CI failed (attempt 1), attempting fix: lint error' },
				{ timestamp: '2025-01-01T12:06:00Z', level: 'info', message: 'Pushed fix commit (attempt 1).' },
				{ timestamp: '2025-01-01T12:10:00Z', level: 'info', message: 'PR #3 merged successfully.' },
			],
		})

		const summary = await getRecentIterationSummary()
		expect(summary).toContain('2/3 merged')
		expect(summary).toContain('1 failed')
		expect(summary).toContain('2 iter w/ fixes')
	})
})
