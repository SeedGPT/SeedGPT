import Anthropic from '@anthropic-ai/sdk'
import logger, { getLogBuffer } from '../logger.js'
import { callApi } from '../llm/api.js'

function summarizeToolResult(toolName: string, toolInput: Record<string, unknown>, resultContent: string): string {
	const lines = resultContent.split('\n').length
	switch (toolName) {
	case 'read_file':
		return `[Read ${toolInput.filePath} (${lines} lines)]`
	case 'grep_search': {
		const matchCount = resultContent === 'No matches found.' ? 0 : lines
		return `[Searched "${(toolInput.query as string).slice(0, 60)}": ${matchCount} match${matchCount !== 1 ? 'es' : ''}]`
	}
	case 'file_search':
		return `[File search: ${resultContent === 'No files matched.' ? 0 : lines} result${lines !== 1 ? 's' : ''}]`
	case 'list_directory':
		return `[Listed ${toolInput.path}: ${lines} entr${lines !== 1 ? 'ies' : 'y'}]`
	case 'git_diff':
		return `[Diff: ${lines} lines]`
	case 'codebase_context':
	case 'codebase_diff':
		return `[Codebase context viewed: ${lines} lines]`
	default:
		return resultContent.slice(0, 200)
	}
}

function buildTranscript(messages: Anthropic.MessageParam[]): string {
	const toolNames = new Map<string, { name: string; input: Record<string, unknown> }>()
	const parts: string[] = []

	for (const msg of messages) {
		if (!Array.isArray(msg.content)) {
			if (msg.role === 'assistant' && typeof msg.content === 'string') parts.push(msg.content)
			continue
		}

		for (const block of msg.content) {
			if (block.type === 'text' && 'text' in block) {
				if (msg.role === 'assistant') parts.push((block as Anthropic.TextBlockParam).text)
			} else if (block.type === 'tool_use') {
				toolNames.set(block.id, { name: block.name, input: block.input as Record<string, unknown> })
				parts.push(`[tool: ${block.name}]`)
			} else if (block.type === 'tool_result') {
				const text = typeof block.content === 'string' ? block.content : ''
				const tool = toolNames.get(block.tool_use_id)
				const compressed = tool ? summarizeToolResult(tool.name, tool.input, text) : text.slice(0, 100)
				parts.push(`[result${block.is_error ? ' ERROR' : ''}] ${compressed}`)
			}
		}
	}

	return parts.join('\n')
}

export async function reflect(outcome: string, messages: Anthropic.MessageParam[]): Promise<{ reflection: string; tokenUsage: { input: number; output: number } }> {
	logger.info('Self-reflecting on iteration...')

	const logs = getLogBuffer()
		.filter(e => e.level !== 'debug')
		.map(e => `${e.timestamp.slice(11, 19)} [${e.level.toUpperCase()}] ${e.message}`)
		.join('\n')

	const transcript = [
		'## Iteration Log',
		logs,
		'## Conversation',
		buildTranscript(messages),
		'## Outcome',
		outcome,
	].join('\n\n')

	const response = await callApi('reflect', [{
		role: 'user',
		content: transcript,
	}])
	logger.info(`Reflect usage: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens`)

	const text = response.content.find(c => c.type === 'text')?.text ?? ''
	logger.info(`Reflection: ${text.slice(0, 200)}`)
	return {
		reflection: text.trim(),
		tokenUsage: {
			input: response.usage.input_tokens,
			output: response.usage.output_tokens,
		},
	}
}
