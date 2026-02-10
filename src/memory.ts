import Anthropic from '@anthropic-ai/sdk'
import MemoryModel from './models/Memory.js'
import GeneratedModel from './models/Generated.js'
import { config } from './config.js'
import logger from './logger.js'
import { trackUsage } from './usage.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

async function summarize(content: string): Promise<string> {
	const response = await client.messages.create({
		model: config.planModel,
		max_tokens: 64,
		system: [
			'Write a one-sentence summary (under 25 words) of this memory.',
			'Capture the core what and why so a reader understands the gist without needing the full text,',
			'but also senses there is deeper detail worth recalling.',
			'Only reference information explicitly present — never infer, elaborate, or add details not stated.',
			'No preamble.',
		].join(' '),
		messages: [{ role: 'user', content }],
	})
	trackUsage('memory.summarize', config.planModel, response.usage)
	const text = response.content.find(c => c.type === 'text')?.text ?? content.slice(0, 200)
	return text.trim()
}

export async function store(content: string): Promise<void> {
	const summary = await summarize(content)
	await MemoryModel.create({ content, summary })
	logger.debug(`Stored memory: ${summary.slice(0, 80)}`)
}

export async function pin(content: string): Promise<string> {
	const summary = await summarize(content)
	const memory = await MemoryModel.create({ content, summary, pinned: true })
	logger.debug(`Pinned note: ${summary.slice(0, 80)}`)
	return `Note saved (${memory._id}): ${summary}`
}

export async function unpin(id: string): Promise<string> {
	const memory = await MemoryModel.findById(id)
	if (!memory) return `No note found with id "${id}".`
	if (!memory.pinned) return `That memory is not a note.`
	memory.pinned = false
	await memory.save()
	logger.debug(`Dismissed note: ${memory.summary.slice(0, 80)}`)
	return `Note dismissed: ${memory.summary}`
}

// Rough chars/4 approximation instead of actual tokenization — avoids a tokenizer
// dependency for a budget that's already an approximate soft limit.
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

// Builds a memory context string within a token budget. Pinned notes (goals, reminders)
// are always included first since they represent active priorities. Remaining budget is
// filled with past memories newest-first. Only summaries are included — full content
// can be retrieved on-demand via recall/recallById.
export async function getContext(): Promise<string> {
	const budget = config.memoryTokenBudget
	let tokensUsed = 0

	const notes = await MemoryModel
		.find({ pinned: true })
		.sort({ createdAt: -1 })
		.select('_id summary')
		.lean()

	const sections: string[] = []

	if (notes.length > 0) {
		const header = '## Notes to self\n'
		const lines = notes.map(m => `- (${m._id}) ${m.summary}`)
		const notesSection = header + lines.join('\n')
		tokensUsed += estimateTokens(notesSection)
		sections.push(notesSection)
	}

	const remaining = budget - tokensUsed
	if (remaining > 0) {
		const recent = await MemoryModel
			.find({ pinned: false })
			.sort({ createdAt: -1 })
			.select('_id summary createdAt')
			.lean()

		const header = '## Past\n'
		let pastTokens = estimateTokens(header)
		const lines: string[] = []

		for (const m of recent) {
			const date = new Date(m.createdAt).toISOString().slice(0, 19).replace('T', ' ')
			const line = `- (${m._id}) [${date}] ${m.summary}`
			const lineTokens = estimateTokens(line + '\n')
			if (tokensUsed + pastTokens + lineTokens > budget) break
			pastTokens += lineTokens
			lines.push(line)
		}

		if (lines.length > 0) {
			sections.push(header + lines.join('\n'))
		}
	}

	if (sections.length === 0) {
		return 'No memories yet. This is your first run.'
	}

	return sections.join('\n\n')
}

// Two-pass search: first tries MongoDB's $text index for relevance-ranked results,
// then falls back to regex matching. The text index tokenizes differently than simple
// substring search so some queries (partial words, symbols) only match via regex.
export async function recall(query: string): Promise<string> {
	let memories = await MemoryModel
		.find({ $text: { $search: query } }, { score: { $meta: 'textScore' } })
		.sort({ score: { $meta: 'textScore' } })
		.limit(5)
		.lean()

	if (memories.length === 0) {
		const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		memories = await MemoryModel
			.find({ $or: [{ summary: new RegExp(escaped, 'i') }, { content: new RegExp(escaped, 'i') }] })
			.sort({ createdAt: -1 })
			.limit(5)
			.lean()
	}

	if (memories.length === 0) return `No memories matching "${query}".`

	return memories.map(m => {
		const date = new Date(m.createdAt).toISOString().slice(0, 19).replace('T', ' ')
		return `**${m._id}** [${date}]\n${m.content}`
	}).join('\n\n---\n\n')
}

export async function recallById(id: string): Promise<string> {
	const memory = await MemoryModel.findById(id).lean()
	if (!memory) return `No memory with id "${id}".`

	const date = new Date(memory.createdAt).toISOString().slice(0, 19).replace('T', ' ')
	return `**${memory._id}** [${date}]\n${memory.content}`
}

// Retrieves recent iteration history to enable learning from past successes and failures.
// Returns formatted history of the most recent 10 iterations including plan titles,
// outcomes, reflections, and timestamps. Returns empty string if no history exists.
export async function getIterationHistory(): Promise<string> {
	try {
		const iterations = await GeneratedModel
			.find()
			.sort({ createdAt: -1 })
			.limit(10)
			.select('planTitle outcome reflection createdAt')
			.lean()

		if (iterations.length === 0) {
			return ''
		}

		const formatted = iterations.map(iter => {
			const date = new Date(iter.createdAt).toISOString().slice(0, 19).replace('T', ' ')
			return [
				`### ${iter.planTitle}`,
				`**Outcome:** ${iter.outcome}`,
				`**Timestamp:** ${date}`,
				`**Reflection:**`,
				iter.reflection,
			].join('\n')
		})

		return formatted.join('\n\n---\n\n')
	} catch (error) {
		logger.error('Failed to retrieve iteration history', { error })
		return ''
	}
}
