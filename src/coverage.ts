import { readFile } from 'fs/promises'
import { join } from 'path'

interface CoverageMetric {
	total: number
	covered: number
	skipped: number
	pct: number
}

interface FileCoverage {
	statements: CoverageMetric
	branches: CoverageMetric
	functions: CoverageMetric
	lines: CoverageMetric
}

interface CoverageSummary {
	[filePath: string]: FileCoverage
}

export interface CoverageData {
	filePath: string
	statements: number
	branches: number
	functions: number
	lines: number
}

export interface CoverageAnalysis {
	files: CoverageData[]
	totalFiles: number
	averageCoverage: number
}

const COVERAGE_PATH = 'coverage/coverage-summary.json'

function isSourceFile(filePath: string): boolean {
	// Filter out test files and non-source files
	if (filePath.includes('.test.') || filePath.includes('.spec.')) {
		return false
	}
	if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) {
		return false
	}
	return true
}

function calculateAverageCoverage(metric: keyof FileCoverage, files: CoverageData[]): number {
	if (files.length === 0) return 0
	const sum = files.reduce((acc, file) => acc + file[metric], 0)
	return sum / files.length
}

export async function analyzeCoverage(rootPath: string = '.'): Promise<CoverageAnalysis | null> {
	try {
		const coveragePath = join(rootPath, COVERAGE_PATH)
		const content = await readFile(coveragePath, 'utf-8')
		const summary: CoverageSummary = JSON.parse(content)

		const files: CoverageData[] = []

		for (const [filePath, metrics] of Object.entries(summary)) {
			// Skip total summary and non-source files
			if (filePath === 'total' || !isSourceFile(filePath)) {
				continue
			}

			files.push({
				filePath,
				statements: metrics.statements.pct,
				branches: metrics.branches.pct,
				functions: metrics.functions.pct,
				lines: metrics.lines.pct,
			})
		}

		// Calculate average of all four metrics
		const avgStatements = calculateAverageCoverage('statements', files)
		const avgBranches = calculateAverageCoverage('branches', files)
		const avgFunctions = calculateAverageCoverage('functions', files)
		const avgLines = calculateAverageCoverage('lines', files)
		const averageCoverage = (avgStatements + avgBranches + avgFunctions + avgLines) / 4

		return {
			files,
			totalFiles: files.length,
			averageCoverage,
		}
	} catch (error) {
		// Coverage file doesn't exist or is invalid
		return null
	}
}

export async function findUncoveredFiles(rootPath: string = '.', threshold: number = 80): Promise<CoverageData[]> {
	const analysis = await analyzeCoverage(rootPath)
	if (!analysis) {
		return []
	}

	// A file is considered "uncovered" if any of its metrics is below threshold
	return analysis.files.filter((file) => {
		const minCoverage = Math.min(
			file.statements,
			file.branches,
			file.functions,
			file.lines
		)
		return minCoverage < threshold
	})
}

export async function formatCoverageReport(rootPath: string = '.'): Promise<string> {
	const analysis = await analyzeCoverage(rootPath)
	if (!analysis) {
		return 'No coverage data available. Run tests with coverage enabled first.'
	}

	if (analysis.files.length === 0) {
		return 'No source files found in coverage report.'
	}

	// Sort by average coverage (ascending, so lowest coverage files appear first)
	const sortedFiles = [...analysis.files].sort((a, b) => {
		const avgA = (a.statements + a.branches + a.functions + a.lines) / 4
		const avgB = (b.statements + b.branches + b.functions + b.lines) / 4
		return avgA - avgB
	})

	const lines: string[] = []
	lines.push('Coverage Report')
	lines.push('===============')
	lines.push('')
	lines.push(`Total files: ${analysis.totalFiles}`)
	lines.push(`Average coverage: ${analysis.averageCoverage.toFixed(2)}%`)
	lines.push('')
	lines.push('Files (sorted by coverage, lowest first):')
	lines.push('')

	const header = 'File'.padEnd(50) + 'Stmts'.padEnd(10) + 'Branch'.padEnd(10) + 'Funcs'.padEnd(10) + 'Lines'
	lines.push(header)
	lines.push('='.repeat(header.length))

	for (const file of sortedFiles) {
		const filePath = file.filePath.padEnd(50).substring(0, 50)
		const stmts = `${file.statements.toFixed(1)}%`.padEnd(10)
		const branch = `${file.branches.toFixed(1)}%`.padEnd(10)
		const funcs = `${file.functions.toFixed(1)}%`.padEnd(10)
		const lines_pct = `${file.lines.toFixed(1)}%`
		lines.push(`${filePath}${stmts}${branch}${funcs}${lines_pct}`)
	}

	return lines.join('\n')
}
