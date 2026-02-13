import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import logger from '../logger.js'
import { handleTool } from '../tools/definitions.js'
import type { ToolResult } from '../tools/definitions.js'
import { callApi } from '../llm/api.js'
import { toolLogSuffix } from '../logger.js'

export interface Plan {
	title: string
	description: string
	implementation: string
	plannerReasoning?: string
}

export interface PlanResult {
	plan: Plan
	messages: Anthropic.MessageParam[]
	tokenUsage: { input: number; output: number }
}

export async function plan(recentMemory: string, gitLog: string): Promise<PlanResult> {
	logger.info('Asking LLM for a plan...')

	const messages: Anthropic.MessageParam[] = [{
		role: 'user',
		content: `${recentMemory}\n\n## Recent Git History\n${gitLog}\n\nReview your notes and recent memories, then submit your plan.`,
	}]

	let totalInputTokens = 0
	let totalOutputTokens = 0

	const maxRounds = config.maxPlannerRounds
	for (let round = 0; round < maxRounds; round++) {
		logger.info(`Planner turn ${round + 1}/${maxRounds}`)
		const response = await callApi('planner', messages)
		logger.info(`Planner turn ${round + 1} usage: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens`)

		totalInputTokens += response.usage.input_tokens
		totalOutputTokens += response.usage.output_tokens

		const toolBlocks = response.content.filter(c => c.type === 'tool_use')
		if (toolBlocks.length === 0) {
			throw new Error('LLM did not return a tool_use block during planning')
		}

		const submitBlock = toolBlocks.find(b => b.type === 'tool_use' && b.name === 'submit_plan')
		if (submitBlock && submitBlock.type === 'tool_use') {
			const input = submitBlock.input as Plan

			const reasoning = messages
				.filter(m => m.role === 'assistant')
				.flatMap(m => {
					const content = m.content
					if (typeof content === 'string') return [content]
					if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => (c as Anthropic.TextBlock).text)
					return []
				})
				.filter(t => t.trim().length > 0)
			const currentReasoning = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
			if (currentReasoning.trim()) reasoning.push(currentReasoning)
			if (reasoning.length > 0) {
				input.plannerReasoning = reasoning.join('\n\n---\n\n')
			}

			logger.info(`Plan: "${input.title}" — reasoning: ${(input.plannerReasoning?.length ?? 0)} chars`)
			messages.push({ role: 'assistant', content: response.content })
			return { plan: input, messages, tokenUsage: { input: totalInputTokens, output: totalOutputTokens } }
		}

		const toolResults: ToolResult[] = []

		for (const toolBlock of toolBlocks) {
			if (toolBlock.type !== 'tool_use') continue
			logger.info(`Planner calling ${toolBlock.name}${toolLogSuffix(toolBlock)}`)

			const result = await handleTool(toolBlock.name, toolBlock.input as Record<string, unknown>, toolBlock.id)
			toolResults.push(result)
		}

		toolResults[toolResults.length - 1].content += `\n\n(Turn ${round + 1} of ${maxRounds} — hard limit. Call submit_plan when ready.)`

		messages.push({ role: 'assistant', content: response.content })
		messages.push({ role: 'user', content: toolResults })
	}

	throw new Error(`Planner exceeded maximum rounds (${maxRounds}) without submitting a plan`)
}
