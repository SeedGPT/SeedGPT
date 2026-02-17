import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// Mock mongoose models
const mockGeneratedFind = jest.fn()
const mockGeneratedCountDocuments = jest.fn()
const mockGeneratedDistinct = jest.fn()

const mockMemoryFind = jest.fn()

const mockIterationLogFind = jest.fn()

jest.unstable_mockModule('../models/Generated.js', () => ({
	default: {
		find: mockGeneratedFind,
		countDocuments: mockGeneratedCountDocuments,
		distinct: mockGeneratedDistinct,
	},
	computeCost: jest.fn(),
}))

jest.unstable_mockModule('../models/Memory.js', () => ({
	default: {
		find: mockMemoryFind,
	},
}))

jest.unstable_mockModule('../models/IterationLog.js', () => ({
	default: {
		find: mockIterationLogFind,
	},
}))

const { queryPerformanceMetrics } = await import('./metrics.js')

beforeEach(() => {
	jest.clearAllMocks()
})

describe('queryPerformanceMetrics', () => {
	describe('summary metric', () => {
		it('should return overall statistics', async () => {
			mockGeneratedCountDocuments.mockResolvedValue(150)
			mockGeneratedDistinct.mockResolvedValue(['iter1', 'iter2', 'iter3'])
			
			// Mock aggregate for cost sum
			mockGeneratedFind.mockReturnValue({
				select: jest.fn().mockReturnValue({
					exec: jest.fn().mockResolvedValue([
						{ cost: 1.5 },
						{ cost: 2.0 },
						{ cost: 0.5 },
					]),
				}),
			})

			mockMemoryFind.mockReturnValue({
				select: jest.fn().mockReturnValue({
					exec: jest.fn().mockResolvedValue([
						{ content: 'Successfully completed task' },
						{ content: 'Failed to build' },
					]),
				}),
			})

			const result = await queryPerformanceMetrics('summary')

			expect(result).toContain('150')
			expect(result).toContain('3')
			expect(result).toContain('4.00')
			expect(mockGeneratedCountDocuments).toHaveBeenCalled()
			expect(mockGeneratedDistinct).toHaveBeenCalledWith('iterationId')
		})

		it('should handle empty database gracefully', async () => {
			mockGeneratedCountDocuments.mockResolvedValue(0)
			mockGeneratedDistinct.mockResolvedValue([])
			mockGeneratedFind.mockReturnValue({
				select: jest.fn().mockReturnValue({
					exec: jest.fn().mockResolvedValue([]),
				}),
			})
			mockMemoryFind.mockReturnValue({
				select: jest.fn().mockReturnValue({
					exec: jest.fn().mockResolvedValue([]),
				}),
			})

			const result = await queryPerformanceMetrics('summary')

			expect(result).toContain('0')
			expect(result).toContain('first iteration')
		})

		it('should handle database errors', async () => {
			mockGeneratedCountDocuments.mockRejectedValue(new Error('Database connection failed'))

			const result = await queryPerformanceMetrics('summary')

			expect(result).toContain('Error')
			expect(result).toContain('Database connection failed')
		})
	})

	describe('token_usage metric', () => {
		it('should return recent token usage data', async () => {
			const mockData = [
				{
					iterationId: 'iter1',
					phase: 'planner',
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cost: 0.5,
					createdAt: new Date('2024-01-01'),
				},
				{
					iterationId: 'iter1',
					phase: 'builder',
					inputTokens: 2000,
					outputTokens: 1000,
					cacheReadTokens: 300,
					cost: 1.0,
					createdAt: new Date('2024-01-01'),
				},
			]

			mockGeneratedFind.mockReturnValue({
				sort: jest.fn().mockReturnValue({
					limit: jest.fn().mockReturnValue({
						select: jest.fn().mockReturnValue({
							exec: jest.fn().mockResolvedValue(mockData),
						}),
					}),
				}),
			})

			const result = await queryPerformanceMetrics('token_usage', 10)

			expect(result).toContain('iter1')
			expect(result).toContain('planner')
			expect(result).toContain('1000')
			expect(result).toContain('500')
			expect(mockGeneratedFind).toHaveBeenCalled()
		})

		it('should respect the limit parameter', async () => {
			const mockLimit = jest.fn().mockReturnValue({
				select: jest.fn().mockReturnValue({
					exec: jest.fn().mockResolvedValue([]),
				}),
			})

			mockGeneratedFind.mockReturnValue({
				sort: jest.fn().mockReturnValue({
					limit: mockLimit,
				}),
			})

			await queryPerformanceMetrics('token_usage', 5)

			expect(mockLimit).toHaveBeenCalledWith(5)
		})
	})

	describe('recent_iterations metric', () => {
		it('should return recent iteration logs', async () => {
			const mockLogs = [
				{
					entries: [
						{ timestamp: '2024-01-01T10:00:00Z', level: 'info', message: 'Starting iteration' },
						{ timestamp: '2024-01-01T10:05:00Z', level: 'error', message: 'Build failed' },
					],
					createdAt: new Date('2024-01-01'),
				},
			]

			mockIterationLogFind.mockReturnValue({
				sort: jest.fn().mockReturnValue({
					limit: jest.fn().mockReturnValue({
						exec: jest.fn().mockResolvedValue(mockLogs),
					}),
				}),
			})

			const result = await queryPerformanceMetrics('recent_iterations', 5)

			expect(result).toContain('Starting iteration')
			expect(result).toContain('Build failed')
			expect(mockIterationLogFind).toHaveBeenCalled()
		})

		it('should handle no iterations', async () => {
			mockIterationLogFind.mockReturnValue({
				sort: jest.fn().mockReturnValue({
					limit: jest.fn().mockReturnValue({
						exec: jest.fn().mockResolvedValue([]),
					}),
				}),
			})

			const result = await queryPerformanceMetrics('recent_iterations')

			expect(result).toContain('No iterations')
		})
	})

	describe('reflections metric', () => {
		it('should return recent reflections', async () => {
			const mockReflections = [
				{
					content: 'We need to improve our test coverage strategy',
					summary: 'Test coverage improvements',
					createdAt: new Date('2024-01-01'),
				},
				{
					content: 'Build times are increasing',
					summary: 'Build performance',
					createdAt: new Date('2023-12-31'),
				},
			]

			mockMemoryFind.mockReturnValue({
				sort: jest.fn().mockReturnValue({
					limit: jest.fn().mockReturnValue({
						select: jest.fn().mockReturnValue({
							exec: jest.fn().mockResolvedValue(mockReflections),
						}),
					}),
				}),
			})

			const result = await queryPerformanceMetrics('reflections', 10)

			expect(result).toContain('test coverage')
			expect(result).toContain('Build times')
			expect(mockMemoryFind).toHaveBeenCalledWith({ category: 'reflection' })
		})

		it('should handle no reflections', async () => {
			mockMemoryFind.mockReturnValue({
				sort: jest.fn().mockReturnValue({
					limit: jest.fn().mockReturnValue({
						select: jest.fn().mockReturnValue({
							exec: jest.fn().mockResolvedValue([]),
						}),
					}),
				}),
			})

			const result = await queryPerformanceMetrics('reflections')

			expect(result).toContain('No reflections')
		})
	})

	describe('unknown metric', () => {
		it('should return error for unknown metric type', async () => {
			const result = await queryPerformanceMetrics('invalid_metric')

			expect(result).toContain('Unknown metric type')
			expect(result).toContain('invalid_metric')
		})
	})
})
