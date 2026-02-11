import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockReadFile = jest.fn<(path: string, encoding: string) => Promise<string>>()
	.mockResolvedValue('')

jest.unstable_mockModule('fs/promises', () => ({
	readFile: mockReadFile,
}))

const { analyzeCoverage, findUncoveredFiles, formatCoverageReport } = await import('./coverage.js')

describe('coverage', () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	const sampleCoverage = {
		'src/api.ts': {
			statements: { total: 100, covered: 90, skipped: 0, pct: 90 },
			branches: { total: 50, covered: 40, skipped: 0, pct: 80 },
			functions: { total: 20, covered: 18, skipped: 0, pct: 90 },
			lines: { total: 95, covered: 85, skipped: 0, pct: 89.47 },
		},
		'src/logger.ts': {
			statements: { total: 50, covered: 25, skipped: 0, pct: 50 },
			branches: { total: 20, covered: 10, skipped: 0, pct: 50 },
			functions: { total: 10, covered: 5, skipped: 0, pct: 50 },
			lines: { total: 45, covered: 22, skipped: 0, pct: 48.89 },
		},
		'src/database.ts': {
			statements: { total: 80, covered: 80, skipped: 0, pct: 100 },
			branches: { total: 30, covered: 30, skipped: 0, pct: 100 },
			functions: { total: 15, covered: 15, skipped: 0, pct: 100 },
			lines: { total: 75, covered: 75, skipped: 0, pct: 100 },
		},
		'src/api.test.ts': {
			statements: { total: 60, covered: 60, skipped: 0, pct: 100 },
			branches: { total: 10, covered: 10, skipped: 0, pct: 100 },
			functions: { total: 8, covered: 8, skipped: 0, pct: 100 },
			lines: { total: 55, covered: 55, skipped: 0, pct: 100 },
		},
		'jest.config.js': {
			statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
			branches: { total: 2, covered: 2, skipped: 0, pct: 100 },
			functions: { total: 1, covered: 1, skipped: 0, pct: 100 },
			lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
		},
		total: {
			statements: { total: 300, covered: 265, skipped: 0, pct: 88.33 },
			branches: { total: 112, covered: 92, skipped: 0, pct: 82.14 },
			functions: { total: 54, covered: 47, skipped: 0, pct: 87.04 },
			lines: { total: 280, covered: 247, skipped: 0, pct: 88.21 },
		},
	}

	describe('analyzeCoverage', () => {
		it('should parse coverage data and return analysis', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const result = await analyzeCoverage('/test/root')

			expect(result).not.toBeNull()
			expect(result?.totalFiles).toBe(3) // Only source files, excluding test and config
			expect(result?.files).toHaveLength(3)
			expect(result?.files[0].filePath).toBe('src/api.ts')
			expect(result?.files[0].statements).toBe(90)
			expect(result?.files[0].branches).toBe(80)
			expect(result?.files[0].functions).toBe(90)
			expect(result?.files[0].lines).toBe(89.47)
		})

		it('should calculate average coverage across all metrics', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const result = await analyzeCoverage('/test/root')

			expect(result).not.toBeNull()
			// api.ts: (90 + 80 + 90 + 89.47) / 4 = 87.3675
			// logger.ts: (50 + 50 + 50 + 48.89) / 4 = 49.7225
			// database.ts: (100 + 100 + 100 + 100) / 4 = 100
			// Average of averages: (87.3675 + 49.7225 + 100) / 3 = 79.03
			// Then average across 4 metrics...
			// Actually: avg(statements) + avg(branches) + avg(functions) + avg(lines) / 4
			// statements: (90 + 50 + 100) / 3 = 80
			// branches: (80 + 50 + 100) / 3 = 76.67
			// functions: (90 + 50 + 100) / 3 = 80
			// lines: (89.47 + 48.89 + 100) / 3 = 79.45
			// total: (80 + 76.67 + 80 + 79.45) / 4 = 79.03
			expect(result?.averageCoverage).toBeCloseTo(79.03, 1)
		})

		it('should filter out test files', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const result = await analyzeCoverage('/test/root')

			expect(result).not.toBeNull()
			const fileNames = result?.files.map((f) => f.filePath) ?? []
			expect(fileNames).not.toContain('src/api.test.ts')
		})

		it('should filter out non-TypeScript/JavaScript files', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const result = await analyzeCoverage('/test/root')

			expect(result).not.toBeNull()
			const fileNames = result?.files.map((f) => f.filePath) ?? []
			expect(fileNames).not.toContain('jest.config.js')
		})

		it('should return null when coverage file does not exist', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT: file not found'))

			const result = await analyzeCoverage('/test/root')

			expect(result).toBeNull()
		})

		it('should return null when coverage file is invalid JSON', async () => {
			mockReadFile.mockResolvedValue('invalid json {')

			const result = await analyzeCoverage('/test/root')

			expect(result).toBeNull()
		})

		it('should handle empty coverage data', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify({ total: {} }))

			const result = await analyzeCoverage('/test/root')

			expect(result).not.toBeNull()
			expect(result?.totalFiles).toBe(0)
			expect(result?.files).toHaveLength(0)
			expect(result?.averageCoverage).toBe(0)
		})
	})

	describe('findUncoveredFiles', () => {
		it('should identify files below threshold', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const result = await findUncoveredFiles('/test/root', 80)

			expect(result).toHaveLength(1)
			expect(result[0].filePath).toBe('src/logger.ts')
		})

		it('should use minimum coverage metric for threshold check', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			// api.ts has branches at 80%, which is the minimum
			const result = await findUncoveredFiles('/test/root', 85)

			expect(result).toHaveLength(2)
			const fileNames = result.map((f) => f.filePath)
			expect(fileNames).toContain('src/api.ts')
			expect(fileNames).toContain('src/logger.ts')
		})

		it('should return empty array when no coverage data exists', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT: file not found'))

			const result = await findUncoveredFiles('/test/root', 80)

			expect(result).toHaveLength(0)
		})

		it('should return empty array when all files meet threshold', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const result = await findUncoveredFiles('/test/root', 40)

			expect(result).toHaveLength(0)
		})

		it('should support custom threshold values', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const result = await findUncoveredFiles('/test/root', 95)

			expect(result).toHaveLength(2) // api.ts and logger.ts both have metrics < 95
			const fileNames = result.map((f) => f.filePath)
			expect(fileNames).toContain('src/api.ts')
			expect(fileNames).toContain('src/logger.ts')
		})
	})

	describe('formatCoverageReport', () => {
		it('should format a human-readable report', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const report = await formatCoverageReport('/test/root')

			expect(report).toContain('Coverage Report')
			expect(report).toContain('Total files: 3')
			expect(report).toContain('Average coverage:')
			expect(report).toContain('src/api.ts')
			expect(report).toContain('src/logger.ts')
			expect(report).toContain('src/database.ts')
		})

		it('should sort files by coverage (lowest first)', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const report = await formatCoverageReport('/test/root')

			const lines = report.split('\n')
			// Find the data lines (after the separator)
			const separatorIndex = lines.findIndex((line) => line.startsWith('==='))
			const dataLines = lines.slice(separatorIndex + 1).filter((line) => line.trim())

			// logger.ts should be first (lowest coverage ~50%)
			expect(dataLines[0]).toContain('src/logger.ts')
			// api.ts should be second (~87%)
			expect(dataLines[1]).toContain('src/api.ts')
			// database.ts should be last (100%)
			expect(dataLines[2]).toContain('src/database.ts')
		})

		it('should return message when coverage data does not exist', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT: file not found'))

			const report = await formatCoverageReport('/test/root')

			expect(report).toBe('No coverage data available. Run tests with coverage enabled first.')
		})

		it('should handle empty coverage data', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify({ total: {} }))

			const report = await formatCoverageReport('/test/root')

			expect(report).toBe('No source files found in coverage report.')
		})

		it('should include all four coverage metrics', async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(sampleCoverage))

			const report = await formatCoverageReport('/test/root')

			expect(report).toContain('Stmts')
			expect(report).toContain('Branch')
			expect(report).toContain('Funcs')
			expect(report).toContain('Lines')
		})
	})
})
