import GeneratedModel from '../models/Generated.js'
import IterationLogModel from '../models/IterationLog.js'
import logger from '../logger.js'

/**
 * Get a concise summary of the last N iterations for planner context.
 * Returns stats on merge success rate, fix attempts, and common issues.
 */
export async function getRecentIterationSummary(limit = 10): Promise<string> {
	try {
		// Get last N iteration logs (each log represents one complete iteration)
		const recentLogs = await IterationLogModel.find()
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean()
			.exec()

		if (recentLogs.length === 0) {
			return ''
		}

		let merged = 0
		let failed = 0
		let iterationsWithFixes = 0
		const issues: Record<string, number> = {}

		for (const log of recentLogs) {
			const entries = log.entries || []
			let hasMerge = false
			let hasFix = false

			for (const entry of entries) {
				const msg = entry.message || ''

				// Check for merge success
				if (msg.includes('merged successfully') || msg.includes('merged, branch deleted')) {
					hasMerge = true
				}

				// Check for fixes
				if (msg.includes('attempting fix') || msg.includes('Pushed fix commit')) {
					hasFix = true
				}

				// Track failure types
				if (msg.includes('test fail') || msg.includes('Tests failed')) {
					issues['test failures'] = (issues['test failures'] || 0) + 1
				} else if (msg.includes('build fail') || msg.includes('Build failed')) {
					issues['build failures'] = (issues['build failures'] || 0) + 1
				} else if (msg.includes('type check') || msg.includes('Type error')) {
					issues['type errors'] = (issues['type errors'] || 0) + 1
				} else if (msg.includes('lint') || msg.includes('Lint failed')) {
					issues['lint errors'] = (issues['lint errors'] || 0) + 1
				}
			}

			if (hasMerge) merged++
			else failed++

			if (hasFix) iterationsWithFixes++
		}

		// Format the summary
		const parts: string[] = []
		parts.push(`Recent ${recentLogs.length} iterations: ${merged} merged, ${failed} failed`)

		if (iterationsWithFixes > 0) {
			parts.push(`Fix attempts: ${iterationsWithFixes} iterations needed 1+ fix`)
		}

		const issueList = Object.entries(issues)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([type, count]) => `${type}: ${count}`)

		if (issueList.length > 0) {
			parts.push(`Common issues: [${issueList.join(', ')}]`)
		}

		return parts.join(' | ')
	} catch (error) {
		logger.error('Failed to compute recent iteration summary', { error })
		return ''
	}
}

export interface PhaseStats {
	count: number
	totalCost: number
	avgCost: number
	totalInputTokens: number
	totalOutputTokens: number
	avgInputTokens: number
	avgOutputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	cacheHitRate: number
}

export interface AnalysisReport {
	totalIterations: number
	dateRange: {
		earliest: Date | null
		latest: Date | null
	}
	apiUsage: {
		totalCost: number
		totalCalls: number
		byPhase: Record<string, PhaseStats>
	}
	cacheEfficiency: {
		overallHitRate: number
		totalCacheReads: number
		totalCacheWrites: number
	}
	modelUsage: Record<string, number>
	stopReasons: Record<string, number>
	commonLogPatterns: {
		errorCount: number
		warningCount: number
		totalLogEntries: number
	}
}

function computePhaseStats(records: Array<{
	cost: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWrite5mTokens: number
	cacheWrite1hTokens: number
}>): PhaseStats {
	const count = records.length
	if (count === 0) {
		return {
			count: 0,
			totalCost: 0,
			avgCost: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			avgInputTokens: 0,
			avgOutputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheHitRate: 0,
		}
	}

	const totalCost = records.reduce((sum, r) => sum + r.cost, 0)
	const totalInputTokens = records.reduce((sum, r) => sum + r.inputTokens, 0)
	const totalOutputTokens = records.reduce((sum, r) => sum + r.outputTokens, 0)
	const cacheReadTokens = records.reduce((sum, r) => sum + r.cacheReadTokens, 0)
	const cacheWriteTokens = records.reduce((sum, r) => sum + r.cacheWrite5mTokens + r.cacheWrite1hTokens, 0)

	const totalInputIncludingCache = totalInputTokens + cacheWriteTokens + cacheReadTokens
	const cacheHitRate = totalInputIncludingCache > 0 ? cacheReadTokens / totalInputIncludingCache : 0

	return {
		count,
		totalCost,
		avgCost: totalCost / count,
		totalInputTokens,
		totalOutputTokens,
		avgInputTokens: totalInputTokens / count,
		avgOutputTokens: totalOutputTokens / count,
		cacheReadTokens,
		cacheWriteTokens,
		cacheHitRate,
	}
}

export async function analyzeIterations(options?: { limit?: number; since?: Date }): Promise<AnalysisReport> {
	logger.info('Analyzing iteration history...')

	const query: Record<string, unknown> = {}
	if (options?.since) {
		query.createdAt = { $gte: options.since }
	}

	let generatedQuery = GeneratedModel.find(query).sort({ createdAt: -1 })
	let logQuery = IterationLogModel.find(query).sort({ createdAt: -1 })

	if (options?.limit) {
		generatedQuery = generatedQuery.limit(options.limit * 10) // Generous limit since multiple API calls per iteration
		logQuery = logQuery.limit(options.limit)
	}

	const [generatedRecords, logRecords] = await Promise.all([
		generatedQuery.lean(),
		logQuery.lean(),
	])

	logger.info(`Found ${generatedRecords.length} API calls and ${logRecords.length} iteration logs`)

	if (generatedRecords.length === 0) {
		return {
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
	}

	// Group records by phase
	const byPhase = new Map<string, typeof generatedRecords>()
	for (const record of generatedRecords) {
		const phase = record.phase as string
		if (!byPhase.has(phase)) {
			byPhase.set(phase, [])
		}
		byPhase.get(phase)!.push(record)
	}

	// Compute per-phase statistics
	const phaseStats: Record<string, PhaseStats> = {}
	for (const [phase, records] of byPhase) {
		phaseStats[phase] = computePhaseStats(records.map(r => ({
			cost: r.cost as number,
			inputTokens: r.inputTokens as number,
			outputTokens: r.outputTokens as number,
			cacheReadTokens: r.cacheReadTokens as number,
			cacheWrite5mTokens: r.cacheWrite5mTokens as number,
			cacheWrite1hTokens: r.cacheWrite1hTokens as number,
		})))
	}

	// Overall statistics
	const totalCost = generatedRecords.reduce((sum, r) => sum + (r.cost as number), 0)
	const totalCacheReads = generatedRecords.reduce((sum, r) => sum + (r.cacheReadTokens as number), 0)
	const totalCacheWrites = generatedRecords.reduce((sum, r) => 
		sum + (r.cacheWrite5mTokens as number) + (r.cacheWrite1hTokens as number), 0)
	const totalInput = generatedRecords.reduce((sum, r) => sum + (r.inputTokens as number), 0)
	const totalInputIncludingCache = totalInput + totalCacheWrites + totalCacheReads
	const overallHitRate = totalInputIncludingCache > 0 ? totalCacheReads / totalInputIncludingCache : 0

	// Model usage
	const modelUsage: Record<string, number> = {}
	for (const record of generatedRecords) {
		const model = record.modelId as string
		modelUsage[model] = (modelUsage[model] || 0) + 1
	}

	// Stop reasons
	const stopReasons: Record<string, number> = {}
	for (const record of generatedRecords) {
		const reason = record.stopReason as string
		stopReasons[reason] = (stopReasons[reason] || 0) + 1
	}

	// Log patterns
	let errorCount = 0
	let warningCount = 0
	let totalLogEntries = 0

	for (const log of logRecords) {
		const entries = log.entries as Array<{ level: string }>
		totalLogEntries += entries.length
		for (const entry of entries) {
			if (entry.level === 'error') errorCount++
			if (entry.level === 'warn') warningCount++
		}
	}

	// Date range
	const dates = generatedRecords.map(r => new Date(r.createdAt as Date))
	const earliest = dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null
	const latest = dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))) : null

	// Count unique iterations (approximate by unique iterationId values)
	const uniqueIterations = new Set(generatedRecords.map(r => r.iterationId as string)).size

	return {
		totalIterations: uniqueIterations || logRecords.length,
		dateRange: { earliest, latest },
		apiUsage: {
			totalCost,
			totalCalls: generatedRecords.length,
			byPhase: phaseStats,
		},
		cacheEfficiency: {
			overallHitRate,
			totalCacheReads,
			totalCacheWrites,
		},
		modelUsage,
		stopReasons,
		commonLogPatterns: {
			errorCount,
			warningCount,
			totalLogEntries,
		},
	}
}

export function formatAnalysisReport(report: AnalysisReport): string {
	if (report.totalIterations === 0) {
		return 'No iteration history available yet.'
	}

	const sections: string[] = []

	// Header
	sections.push(`# Iteration Analysis (${report.totalIterations} iteration${report.totalIterations !== 1 ? 's' : ''})`)
	
	if (report.dateRange.earliest && report.dateRange.latest) {
		const earliest = report.dateRange.earliest.toISOString().split('T')[0]
		const latest = report.dateRange.latest.toISOString().split('T')[0]
		if (earliest === latest) {
			sections.push(`Date: ${earliest}`)
		} else {
			sections.push(`Date range: ${earliest} to ${latest}`)
		}
	}

	// API Usage Summary
	sections.push('\n## API Usage')
	sections.push(`Total calls: ${report.apiUsage.totalCalls}`)
	sections.push(`Total cost: $${report.apiUsage.totalCost.toFixed(3)}`)
	sections.push(`Avg cost per call: $${(report.apiUsage.totalCost / report.apiUsage.totalCalls).toFixed(4)}`)

	// Per-phase breakdown
	sections.push('\n### By Phase')
	const phases = Object.entries(report.apiUsage.byPhase).sort(([, a], [, b]) => b.totalCost - a.totalCost)
	for (const [phase, stats] of phases) {
		sections.push(`\n**${phase}** (${stats.count} call${stats.count !== 1 ? 's' : ''})`)
		sections.push(`- Cost: $${stats.totalCost.toFixed(3)} (avg: $${stats.avgCost.toFixed(4)})`)
		sections.push(`- Tokens: ${Math.round(stats.avgInputTokens)} in / ${Math.round(stats.avgOutputTokens)} out (avg)`)
		if (stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) {
			sections.push(`- Cache: ${(stats.cacheHitRate * 100).toFixed(1)}% hit rate`)
		}
	}

	// Cache Efficiency
	sections.push('\n## Cache Efficiency')
	sections.push(`Overall hit rate: ${(report.cacheEfficiency.overallHitRate * 100).toFixed(1)}%`)
	sections.push(`Cache reads: ${report.cacheEfficiency.totalCacheReads.toLocaleString()} tokens`)
	sections.push(`Cache writes: ${report.cacheEfficiency.totalCacheWrites.toLocaleString()} tokens`)

	// Model Usage
	if (Object.keys(report.modelUsage).length > 0) {
		sections.push('\n## Model Usage')
		const models = Object.entries(report.modelUsage).sort(([, a], [, b]) => b - a)
		for (const [model, count] of models) {
			const pct = (count / report.apiUsage.totalCalls * 100).toFixed(1)
			sections.push(`- ${model}: ${count} call${count !== 1 ? 's' : ''} (${pct}%)`)
		}
	}

	// Stop Reasons
	if (Object.keys(report.stopReasons).length > 0) {
		sections.push('\n## Stop Reasons')
		const reasons = Object.entries(report.stopReasons).sort(([, a], [, b]) => b - a)
		for (const [reason, count] of reasons) {
			const pct = (count / report.apiUsage.totalCalls * 100).toFixed(1)
			sections.push(`- ${reason}: ${count} (${pct}%)`)
		}
	}

	// Log Patterns
	sections.push('\n## Log Patterns')
	sections.push(`Total log entries: ${report.commonLogPatterns.totalLogEntries}`)
	if (report.commonLogPatterns.errorCount > 0) {
		sections.push(`Errors: ${report.commonLogPatterns.errorCount}`)
	}
	if (report.commonLogPatterns.warningCount > 0) {
		sections.push(`Warnings: ${report.commonLogPatterns.warningCount}`)
	}

	return sections.join('\n')
}
