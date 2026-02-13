import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import logger from '../logger.js'
import { handleTool, getEditOperation } from '../tools/definitions.js'
import type { EditOperation, ToolResult } from '../tools/definitions.js'
import { callApi } from '../llm/api.js'
import { toolLogSuffix } from '../logger.js'
import type { Plan } from './plan.js'

export type { EditOperation } from '../tools/definitions.js'

export class PatchSession {
	private messages: Anthropic.MessageParam[] = []
	private readonly fullHistory: Anthropic.MessageParam[] = []
	private readonly edits: EditOperation[] = []
	private readonly plan: Plan
	private roundsUsed = 0
	private inputTokens = 0
	private outputTokens = 0

	get conversation(): Anthropic.MessageParam[] {
		return this.fullHistory
	}

	get exhausted(): boolean {
		return this.roundsUsed >= config.maxBuilderRounds
	}

	getTokenUsage(): { input: number; output: number } {
		return { input: this.inputTokens, output: this.outputTokens }
	}

	constructor(plan: Plan, memoryContext: string) {
		this.plan = plan

		const initial: Anthropic.MessageParam = {
			role: 'user',
			content: [{
				type: 'text' as const,
				text: [
					`--- YOUR MEMORY ---\n${memoryContext}`,
					`--- PLAN ---\n**${plan.title}**\n${plan.description}`,
					`--- IMPLEMENTATION INSTRUCTIONS ---\n${plan.implementation}`,
					`--- BEGIN ---\nStart by reading the files you need based on the implementation instructions and the codebase index in your system prompt. Use read_file to load files or specific line ranges, then use edit_file, create_file, and delete_file to make changes. Batch independent read_file calls together. Call done when the implementation is complete.`,
				].join('\n\n'),
				cache_control: { type: 'ephemeral' },
			}],
		}
		this.messages.push(initial)
		this.fullHistory.push(initial)
	}

	async createPatch(): Promise<EditOperation[]> {
		logger.info('Builder starting implementation...')
		return this.runBuilderLoop()
	}

	async fixPatch(error: string): Promise<EditOperation[]> {
		logger.info('Builder fixing implementation...')

		const fixMessage: Anthropic.MessageParam = {
			role: 'user',
			content: [{
				type: 'text' as const,
				text: [
					`You were implementing "${this.plan.title}": ${this.plan.description}`,
					'The changes were applied but CI failed. You have a limited turn budget to diagnose and fix the issue.',
					`## Error\n\`\`\`\n${error}\n\`\`\``,
					'Start by reading the files implicated in the error. If the error points at a test, read that test file. If not, check tests for the modules you changed. Make the targeted fix, then call done. Do not redo work that already succeeded.',
				].join('\n\n'),
				cache_control: { type: 'ephemeral' },
			}],
		}
		this.messages = [fixMessage]
		this.fullHistory.push(fixMessage)

		this.edits.length = 0
		return this.runBuilderLoop()
	}

	private pushMessage(msg: Anthropic.MessageParam): void {
		this.messages.push(msg)
		this.fullHistory.push(msg)
	}

	private async runBuilderLoop(): Promise<EditOperation[]> {
		const maxRounds = config.maxBuilderRounds
		while (this.roundsUsed < maxRounds) {
			this.roundsUsed++
			logger.info(`Builder turn ${this.roundsUsed}/${maxRounds}`)

			const response = await callApi('builder', this.messages)
			this.inputTokens += response.usage.input_tokens
			this.outputTokens += response.usage.output_tokens
			logger.info(`Builder turn ${this.roundsUsed} usage: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens`)

			this.pushMessage({ role: 'assistant', content: response.content })

			const toolBlocks = response.content.filter(c => c.type === 'tool_use')
			if (toolBlocks.length === 0) {
				if (this.edits.length > 0) {
					logger.info(`Builder stopped responding after ${this.edits.length} edit(s) — treating as done`)
					return this.edits
				}
				throw new Error('Builder did not call any tools')
			}

			const toolResults: ToolResult[] = []

			for (const block of toolBlocks) {
				if (block.type !== 'tool_use') continue
				logger.info(`Builder calling ${block.name}${toolLogSuffix(block)}`)

				const result = await this.handleBuilderTool(block)
				toolResults.push(result)

				if (block.name === 'done') {
					this.pushMessage({ role: 'user', content: toolResults })
					logger.info(`Builder done: ${this.edits.length} edit(s) applied`)
					return this.edits
				}
			}

			toolResults[toolResults.length - 1].content += `\n\n(Turn ${this.roundsUsed} of ${maxRounds} — hard limit. Call done when ready.)`

			this.pushMessage({ role: 'user', content: toolResults })
		}

		if (this.edits.length > 0) {
			logger.warn(`Builder hit turn limit with ${this.edits.length} edit(s) — returning what we have`)
			return this.edits
		}
		throw new Error(`Builder exceeded maximum rounds (${maxRounds}) without completing`)
	}

	private async handleBuilderTool(block: Anthropic.ContentBlock & { type: 'tool_use' }): Promise<ToolResult> {
		const result = await handleTool(block.name, block.input as Record<string, unknown>, block.id)
		if (!result.is_error) {
			const op = getEditOperation(block.name, block.input as Record<string, unknown>)
			if (op) this.edits.push(op)
		}
		return result
	}
}
