import GeneratedModel from './models/Generated.js'
import UsageModel from './models/Usage.js'

export async function queryIterations(limit: number = 10, outcomeFilter?: 'success' | 'failure'): Promise<string> {
	// Build query filter
	const query: Record<string, unknown> = {}
	if (outcomeFilter === 'success') {
		query.outcome = { $regex: /merged successfully|passed/i }
	} else if (outcomeFilter === 'failure') {
		query.outcome = { $regex: /failed|error/i }
	}
	
	// Query with limit
	const iterations = await GeneratedModel
		.find(query)
		.sort({ createdAt: -1 })
		.limit(Math.min(limit, 50))
		.select('planTitle outcome reflection createdAt')
		.lean()
	
	if (iterations.length === 0) {
		return 'No iterations found matching the criteria.'
	}
	
	// Format results
	return iterations.map(it => {
		const date = new Date(it.createdAt).toISOString().slice(0, 19).replace('T', ' ')
		return `[${date}] "${it.planTitle}"\nOutcome: ${it.outcome}\nReflection: ${it.reflection}\n`
	}).join('\n---\n\n')
}

export async function queryUsageTrends(limit: number = 10): Promise<string> {
	const usages = await UsageModel
		.find({})
		.sort({ createdAt: -1 })
		.limit(Math.min(limit, 50))
		.select('planTitle totalCost totalInputTokens totalOutputTokens totalCalls createdAt breakdown')
		.lean()
	
	if (usages.length === 0) {
		return 'No usage data available.'
	}
	
	// Calculate summary stats
	const totalCost = usages.reduce((sum, u) => sum + u.totalCost, 0)
	const avgCost = totalCost / usages.length
	const totalTokens = usages.reduce((sum, u) => sum + u.totalInputTokens + u.totalOutputTokens, 0)
	
	// Format individual entries
	const entries = usages.map(u => {
		const date = new Date(u.createdAt).toISOString().slice(0, 10)
		const models = [...new Set(u.breakdown.map(b => b.model))].join(', ')
		return `[${date}] "${u.planTitle}": $${u.totalCost.toFixed(3)} (${u.totalInputTokens + u.totalOutputTokens} tokens, ${u.totalCalls} calls) [${models}]`
	}).join('\n')
	
	return `Summary (last ${usages.length} iterations):\n- Total cost: $${totalCost.toFixed(3)}\n- Average cost per iteration: $${avgCost.toFixed(3)}\n- Total tokens: ${totalTokens.toLocaleString()}\n\n${entries}`
}

export async function searchReflections(query: string, limit: number = 5): Promise<string> {
	// Use regex search on reflection field
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const iterations = await GeneratedModel
		.find({ reflection: new RegExp(escaped, 'i') })
		.sort({ createdAt: -1 })
		.limit(Math.min(limit, 20))
		.select('planTitle reflection createdAt')
		.lean()
	
	if (iterations.length === 0) {
		return `No reflections matching "${query}".`
	}
	
	return iterations.map(it => {
		const date = new Date(it.createdAt).toISOString().slice(0, 19).replace('T', ' ')
		return `[${date}] After "${it.planTitle}":\n${it.reflection}`
	}).join('\n\n---\n\n')
}
