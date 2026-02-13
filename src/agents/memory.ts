import MemoryModel from '../models/Memory.js'
import { config } from '../config.js'
import logger from '../logger.js'
import { callApi } from '../llm/api.js'

async function summarizeMemory(content: string): Promise<string> {
	const response = await callApi('memory', [{ role: 'user', content }])
	const text = response.content.find(c => c.type === 'text')?.text ?? content.slice(0, 200)
	return text.trim()
}

export async function storePastMemory(content: string): Promise<void> {
	const summary = await summarizeMemory(content)
	await MemoryModel.create({ content, summary })
	logger.debug(`Stored memory: ${summary.slice(0, 80)}`)
}

export async function storePinnedMemory(content: string): Promise<string> {
	const summary = await summarizeMemory(content)
	const memory = await MemoryModel.create({ content, summary, pinned: true })
	logger.debug(`Pinned note: ${summary.slice(0, 80)}`)
	return `Note saved (${memory._id}): ${summary}`
}

export async function unpinMemory(id: string): Promise<string> {
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

	// Split pinned memories into notes (non-idea) and ideas
	const pinnedMemories = await MemoryModel
		.find({ pinned: true })
		.sort({ createdAt: -1 })
		.select('_id summary ideaStatus ideaContext')
		.lean()

	const notes = pinnedMemories.filter(m => !m.ideaStatus)
	const ideas = pinnedMemories.filter(m => m.ideaStatus)

	const sections: string[] = []

	if (notes.length > 0) {
		const header = '## Notes to self\n'
		const lines = notes.map(m => `- (${m._id}) ${m.summary}`)
		const notesSection = header + lines.join('\n')
		tokensUsed += estimateTokens(notesSection)
		sections.push(notesSection)
	}

	if (ideas.length > 0) {
		const header = '## Ideas\n'
		const lines = ideas.map(m => {
			const statusBadge = m.ideaStatus === 'pending' ? '[PENDING]' : '[ATTEMPTED]'
			const context = m.ideaContext ? ` — ${m.ideaContext}` : ''
			return `- ${statusBadge} (${m._id}) ${m.summary}${context}`
		})
		const ideasSection = header + lines.join('\n')
		const ideasTokens = estimateTokens(ideasSection)
		if (tokensUsed + ideasTokens <= budget) {
			tokensUsed += ideasTokens
			sections.push(ideasSection)
		}
	}

	const remaining = budget - tokensUsed
	if (remaining > 0) {
		const recent = await MemoryModel
			.find({ pinned: false, ideaStatus: { $exists: false } })
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

export async function generateIdeas(codebaseContext: string, recentMemory: string): Promise<string[]> {
	const prompt = `You are a code improvement assistant. Based on the current state of the codebase and recent activities, generate 2-5 concrete, actionable ideas for improvements.

Consider:
- Strategic priorities from todo.md
- Recent failures or patterns in past memories
- Current capabilities and what's missing
- Code quality issues or technical debt

Each idea should be:
- Specific and actionable (not vague goals)
- Focused on a single improvement
- Achievable in one development cycle

Return ONLY a JSON array of objects, each with "description" (brief, clear statement of the idea) and "rationale" (why this matters, what problem it solves).

Example format:
[
  {"description": "Add retry logic to GitHub API calls", "rationale": "Reduces failures from transient network issues"},
  {"description": "Extract common test setup into shared fixtures", "rationale": "Reduces duplication across test files"}
]

Codebase Context:
${codebaseContext}

Recent Memory:
${recentMemory}`

	const response = await callApi('memory', [{ role: 'user', content: prompt }])
	const text = response.content.find(c => c.type === 'text')?.text ?? '[]'
	
	try {
		const ideas = JSON.parse(text) as Array<{ description: string; rationale: string }>
		logger.debug(`Generated ${ideas.length} improvement ideas`)
		return ideas.map(idea => `${idea.description}\nRationale: ${idea.rationale}`)
	} catch {
		logger.debug('Failed to parse ideas from LLM response')
		return []
	}
}

export async function storeIdea(description: string, context: string): Promise<string> {
	const summary = await summarizeMemory(description)
	const memory = await MemoryModel.create({
		content: description,
		summary,
		pinned: true,
		ideaStatus: 'pending',
		ideaContext: context,
	})
	logger.debug(`Stored idea: ${summary.slice(0, 80)}`)
	return `Idea saved (${memory._id}): ${summary}`
}

export async function updateIdeaStatus(id: string, status: 'attempted' | 'completed'): Promise<string> {
	const memory = await MemoryModel.findById(id)
	if (!memory) return `No memory found with id "${id}".`
	if (!memory.ideaStatus) return `Memory "${id}" is not an idea.`
	
	memory.ideaStatus = status
	
	// If completed, unpin it to move to past memories
	if (status === 'completed') {
		memory.pinned = false
	}
	
	await memory.save()
	logger.debug(`Updated idea status to ${status}: ${memory.summary.slice(0, 80)}`)
	return `Idea marked as ${status}: ${memory.summary}`
}

export async function getIdeas(): Promise<string> {
	const ideas = await MemoryModel
		.find({ ideaStatus: { $in: ['pending', 'attempted'] } })
		.sort({ createdAt: -1 })
		.select('_id summary ideaStatus ideaContext')
		.lean()
	
	if (ideas.length === 0) return 'No active ideas.'
	
	return ideas.map(idea => {
		const statusBadge = idea.ideaStatus === 'pending' ? '[PENDING]' : '[ATTEMPTED]'
		const context = idea.ideaContext ? `\n  Context: ${idea.ideaContext}` : ''
		return `- ${statusBadge} (${idea._id}) ${idea.summary}${context}`
	}).join('\n')
}
