import GeneratedModel from '../models/Generated.js'
import MemoryModel from '../models/Memory.js'
import IterationLogModel from '../models/IterationLog.js'

export async function queryPerformanceMetrics(metric: string, limit: number = 10): Promise<string> {
	try {
		switch (metric) {
			case 'summary':
				return await getSummaryMetrics()
			case 'token_usage':
				return await getTokenUsageMetrics(limit)
			case 'recent_iterations':
				return await getRecentIterations(limit)
			case 'reflections':
				return await getReflections(limit)
			default:
				return `Unknown metric type: ${metric}. Available: summary, token_usage, recent_iterations, reflections`
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return `Error querying metrics: ${message}. The database may be unavailable or empty.`
	}
}

async function getSummaryMetrics(): Promise<string> {
	// Count total API calls
	const totalCalls = await GeneratedModel.countDocuments()
	
	if (totalCalls === 0) {
		return 'No performance data available yet. This appears to be the first iteration.'
	}

	// Count unique iterations
	const uniqueIterations = await GeneratedModel.distinct('iterationId')
	const iterationCount = uniqueIterations.filter(id => id && id !== '').length

	// Calculate total costs
	const costResult = await GeneratedModel.aggregate([
		{ $group: { _id: null, totalCost: { $sum: '$cost' } } }
	])
	const totalCost = costResult.length > 0 ? costResult[0].totalCost : 0

	// Count reflections with success/failure indicators
	const reflections = await MemoryModel.find({ 
		category: 'reflection', 
		active: true 
	}).select('content').lean()

	let successCount = 0
	let failureCount = 0
	
	for (const reflection of reflections) {
		const content = reflection.content.toLowerCase()
		if (content.includes('success') || content.includes('merged') || content.includes('passed')) {
			successCount++
		}
		if (content.includes('fail') || content.includes('error') || content.includes('reject')) {
			failureCount++
		}
	}

	const totalReflections = reflections.length
	const successRate = totalReflections > 0 
		? Math.round((successCount / totalReflections) * 100)
		: 0

	return `
=== PERFORMANCE SUMMARY ===
Total API Calls: ${totalCalls}
Iterations Logged: ${iterationCount}
Total Cost: $${totalCost.toFixed(4)}
Reflections: ${totalReflections} (${successCount} positive, ${failureCount} negative)
Estimated Success Rate: ${successRate}% (based on reflection sentiment)

Note: Success rate is approximate, based on keyword analysis of reflections.
`.trim()
}

async function getTokenUsageMetrics(limit: number): Promise<string> {
	const records = await GeneratedModel
		.find()
		.sort({ createdAt: -1 })
		.limit(limit)
		.select('phase iterationId inputTokens outputTokens cacheReadTokens cost createdAt')
		.lean()

	if (records.length === 0) {
		return 'No token usage data available yet.'
	}

	let output = '=== TOKEN USAGE (Recent Activity) ===\n\n'
	
	for (const record of records) {
		const date = new Date(record.createdAt).toISOString().split('T')[0]
		const time = new Date(record.createdAt).toISOString().split('T')[1].split('.')[0]
		const cacheInfo = record.cacheReadTokens > 0 ? ` (${record.cacheReadTokens} cached)` : ''
		
		output += `${date} ${time} | ${record.phase.padEnd(10)} | `
		output += `In: ${String(record.inputTokens).padStart(6)} | `
		output += `Out: ${String(record.outputTokens).padStart(6)}${cacheInfo} | `
		output += `Cost: $${record.cost.toFixed(4)}\n`
	}

	// Calculate totals
	const totalInput = records.reduce((sum, r) => sum + r.inputTokens, 0)
	const totalOutput = records.reduce((sum, r) => sum + r.outputTokens, 0)
	const totalCached = records.reduce((sum, r) => sum + r.cacheReadTokens, 0)
	const totalCost = records.reduce((sum, r) => sum + r.cost, 0)

	output += `\nTotals (last ${records.length} calls):\n`
	output += `  Input: ${totalInput.toLocaleString()} tokens\n`
	output += `  Output: ${totalOutput.toLocaleString()} tokens\n`
	output += `  Cached: ${totalCached.toLocaleString()} tokens\n`
	output += `  Cost: $${totalCost.toFixed(4)}`

	return output
}

async function getRecentIterations(limit: number): Promise<string> {
	const logs = await IterationLogModel
		.find()
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean()

	if (logs.length === 0) {
		return 'No iteration logs available yet.'
	}

	let output = '=== RECENT ITERATIONS ===\n\n'

	for (const log of logs) {
		const date = new Date(log.createdAt).toISOString().split('T')[0]
		const time = new Date(log.createdAt).toISOString().split('T')[1].split('.')[0]
		
		output += `${date} ${time}\n`
		
		// Extract key events from log entries
		const keyEvents: string[] = []
		const errors: string[] = []
		const warnings: string[] = []
		
		for (const entry of log.entries) {
			const msg = entry.message.toLowerCase()
			
			if (entry.level === 'error' || msg.includes('error') || msg.includes('fail')) {
				errors.push(entry.message)
			} else if (entry.level === 'warn' || msg.includes('warning')) {
				warnings.push(entry.message)
			} else if (
				msg.includes('success') || 
				msg.includes('merged') || 
				msg.includes('completed') ||
				msg.includes('passed')
			) {
				keyEvents.push(entry.message)
			}
		}

		if (keyEvents.length > 0) {
			output += `  ✓ Success: ${keyEvents[0]}\n`
		}
		if (errors.length > 0) {
			output += `  ✗ Errors: ${errors.length} found\n`
			output += `    - ${errors[0].slice(0, 80)}${errors[0].length > 80 ? '...' : ''}\n`
		}
		if (warnings.length > 0) {
			output += `  ⚠ Warnings: ${warnings.length}\n`
		}
		if (keyEvents.length === 0 && errors.length === 0 && warnings.length === 0) {
			output += `  Total log entries: ${log.entries.length}\n`
		}
		
		output += '\n'
	}

	return output.trim()
}

async function getReflections(limit: number): Promise<string> {
	const reflections = await MemoryModel
		.find({ category: 'reflection' })
		.sort({ createdAt: -1 })
		.limit(limit)
		.select('content summary createdAt active')
		.lean()

	if (reflections.length === 0) {
		return 'No reflections available yet.'
	}

	let output = '=== RECENT REFLECTIONS ===\n\n'

	for (const reflection of reflections) {
		const date = new Date(reflection.createdAt).toISOString().split('T')[0]
		const time = new Date(reflection.createdAt).toISOString().split('T')[1].split('.')[0]
		const status = reflection.active ? '●' : '○'
		
		output += `${status} ${date} ${time}\n`
		
		// Show summary if available, otherwise first line of content
		if (reflection.summary) {
			output += `  ${reflection.summary}\n`
		} else {
			const firstLine = reflection.content.split('\n')[0]
			output += `  ${firstLine.slice(0, 100)}${firstLine.length > 100 ? '...' : ''}\n`
		}
		
		output += '\n'
	}

	return output.trim()
}
