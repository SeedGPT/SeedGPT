import MemoryModel from '../models/Memory.js'
import IterationLogModel from '../models/IterationLog.js'
import { config } from '../config.js'
import logger from '../logger.js'
import { callApi } from '../llm/api.js'

async function summarizeMemory(content: string): Promise<string> {
	const response = await callApi('memory', [{ role: 'user', content }])
	const text = response.content.find(c => c.type === 'text')?.text ?? content.slice(0, 200)
	return text.trim()
}

export async function storeNote(content: string): Promise<string> {
	const summary = await summarizeMemory(content)
	const memory = await MemoryModel.create({ content, summary, category: 'note' })
	logger.debug(`Saved note: ${summary.slice(0, 80)}`)
	return `Note saved (${memory._id}): ${summary}`
}

export async function dismissNote(id: string): Promise<string> {
	const memory = await MemoryModel.findById(id)
	if (!memory) return `No note found with id "${id}".`
	if (memory.category !== 'note') return `That memory is not a note.`
	if (!memory.active) return `That note is already dismissed.`
	memory.active = false
	await memory.save()
	logger.debug(`Dismissed note: ${memory.summary.slice(0, 80)}`)
	return `Note dismissed: ${memory.summary}`
}

export async function storeReflection(content: string): Promise<void> {
	const summary = await summarizeMemory(content)
	await MemoryModel.create({ content, summary, category: 'reflection' })
	logger.debug(`Stored reflection: ${summary.slice(0, 80)}`)
}

// Rough chars/4 approximation instead of actual tokenization — avoids a tokenizer
// dependency for a budget that's already an approximate soft limit.
function estimateTokens(text: string): number {
	return Math.ceil(text.length / config.memory.estimationRatio)
}

export async function getMemoryContext(): Promise<string> {
	const budget = config.memory.tokenBudget
	let tokensUsed = 0
	const sections: string[] = []

	const notes = await MemoryModel
		.find({ category: 'note', active: true })
		.sort({ createdAt: -1 })
		.select('_id summary')
		.lean()

	if (notes.length > 0) {
		const header = '## Notes to self\n'
		const lines = notes.map(m => `- (${m._id}) ${m.summary}`)
		const notesSection = header + lines.join('\n')
		tokensUsed += estimateTokens(notesSection)
		sections.push(notesSection)
	}

	const reflections = await MemoryModel
		.find({ category: 'reflection' })
		.sort({ createdAt: -1 })
		.limit(config.memory.fullReflections + config.memory.summarizedReflections)
		.select('_id content summary createdAt')
		.lean()

	if (reflections.length > 0) {
		const header = '## Recent Reflections\n'
		let reflectionTokens = estimateTokens(header)
		const lines: string[] = []

		for (let i = 0; i < reflections.length; i++) {
			const m = reflections[i]
			const date = new Date(m.createdAt).toISOString().slice(0, 19).replace('T', ' ')
			const text = i < config.memory.fullReflections ? m.content : m.summary
			const line = `- (${m._id}) [${date}] ${text}`
			const lineTokens = estimateTokens(line + '\n')
			if (tokensUsed + reflectionTokens + lineTokens > budget) break
			reflectionTokens += lineTokens
			lines.push(line)
		}

		if (lines.length > 0) {
			tokensUsed += reflectionTokens
			sections.push(header + lines.join('\n'))
		}
	}

	if (sections.length === 0) {
		return 'No memories yet.'
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

export async function listIterations(limit: number = 10): Promise<string> {
	const iterations = await IterationLogModel
		.find({})
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean()

	if (iterations.length === 0) return 'No iterations found in database.'

	return iterations.map(iter => {
		const date = new Date(iter.createdAt).toISOString().slice(0, 19).replace('T', ' ')
		
		// Determine outcome from log entries
		const logText = iter.entries.map(e => e.message.toLowerCase()).join(' ')
		let outcome = 'unknown'
		
		if (logText.includes('merged pr') || logText.includes('merged successfully')) {
			outcome = 'success'
		} else if (logText.includes('max turns') || logText.includes('gave up') || logText.includes('ci failed') || logText.includes('checks failed')) {
			outcome = 'failure'
		} else if (logText.includes('closing pr') || logText.includes('aborting')) {
			outcome = 'aborted'
		} else if (logText.includes('running') || logText.includes('started')) {
			outcome = 'in-progress'
		}
		
		return `[${date}] ${iter._id}: ${outcome}`
	}).join('\n')
}
