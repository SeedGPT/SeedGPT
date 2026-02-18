import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { env } from '../env.js'
import logger from '../logger.js'
import { prepareAndBuildContext } from '../agents/context.js'
import { PLANNER_TOOLS, BUILDER_TOOLS } from '../tools/definitions.js'
import { getCodebaseContext, findUnusedFunctions } from '../tools/codebase.js'
import { SYSTEM_PLAN, SYSTEM_BUILD, SYSTEM_FIX, SYSTEM_REFLECT, SYSTEM_MEMORY } from '../llm/prompts.js'
import GeneratedModel, { computeCost, type ApiUsage } from '../models/Generated.js'
import { getMemoryContext } from '../agents/memory.js'
import { getRecentLog } from '../tools/git.js'
import { getLatestMainCoverage } from '../tools/github.js'

export type Phase = 'planner' | 'builder' | 'fixer' | 'reflect' | 'memory'

const client = new Anthropic({ apiKey: env.anthropicApiKey })

const PHASE_EXTRAS: Record<Phase, {
	system: string
	tools?: Anthropic.Tool[]
}> = {
	planner: { system: SYSTEM_PLAN, tools: PLANNER_TOOLS },
	builder: { system: SYSTEM_BUILD, tools: BUILDER_TOOLS },
	fixer: { system: SYSTEM_FIX, tools: BUILDER_TOOLS },
	reflect: { system: SYSTEM_REFLECT },
	memory: { system: SYSTEM_MEMORY },
}

const THINKING_PHASES = new Set<Phase>(['planner', 'builder', 'fixer', 'reflect'])
const MIN_OUTPUT_TOKENS = 2048

async function buildParams(phase: Phase, messages: Anthropic.MessageParam[], tools?: Anthropic.Tool[]): Promise<Anthropic.MessageCreateParamsNonStreaming> {
	const useContext = phase !== 'memory'
	let workingContext: string | null = null

	if (useContext) {
		workingContext = await prepareAndBuildContext(env.workspacePath, messages)
	}

	const { model, maxTokens } = config.phases[phase]
	const extras = PHASE_EXTRAS[phase]
	const system: Anthropic.TextBlockParam[] = []

	// Block 0: Base system prompt
	system.push({ type: 'text', text: extras.system })

	// Block 1: Codebase context (stable, large content - cache marker goes here)
	let cacheMarkerIndex = 0
	if (phase === 'builder' || phase === 'fixer' || phase === 'planner') {
		const codebaseContext = await getCodebaseContext(env.workspacePath)
		system.push({ type: 'text', text: `\n\n${codebaseContext}`, cache_control: { type: 'ephemeral' as const } })
		cacheMarkerIndex = system.length - 1
	} else {
		// For phases without codebase context (memory, reflect), cache the base system prompt
		system[0].cache_control = { type: 'ephemeral' as const }
	}

	// Dynamic content blocks (appended after cache marker)
	if (phase === 'planner') {
		const coverage = await getLatestMainCoverage()
		if (coverage) {
			system.push({ type: 'text', text: `\n\n## Code Coverage (last CI run on main)\n${coverage}` })
		}
		const gitLog = await getRecentLog()
		system.push({ type: 'text', text: `\n\nRecent git log:\n${gitLog}` })
		const memoryContext = await getMemoryContext()
		system.push({ type: 'text', text: `\n\n${memoryContext}` })
		const unusedFunctions = await findUnusedFunctions(env.workspacePath)
		if (unusedFunctions) {
			system.push({ type: 'text', text: `\n\n## Unused Functions\n${unusedFunctions}` })
		}
	}

	// Working context (session-specific, always last)
	if (workingContext) {
		system.push({ type: 'text', text: `\n\n${workingContext}` })
	}

	const allTools = [...(extras.tools ?? []), ...(tools ?? [])]

	const useThinking = THINKING_PHASES.has(phase)
	const thinkingBudget = Math.min(config.context.thinkingBudget, maxTokens - MIN_OUTPUT_TOKENS)
	const effectiveMaxTokens = useThinking ? maxTokens + thinkingBudget : maxTokens

	return {
		model,
		max_tokens: effectiveMaxTokens,
		system,
		messages,
		...(allTools.length > 0 && { tools: allTools }),
		...(useThinking && { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }),
	}
}

let activeIterationId = ''

export function setIterationId(id: string): void {
	activeIterationId = id
}

function stripThinkingSignatures(content: Anthropic.ContentBlock[]): Anthropic.ContentBlock[] {
	return content.map(block => {
		if (block.type === 'thinking') {
			const { signature: _, ...rest } = block as { signature?: string } & typeof block
			return rest as Anthropic.ContentBlock
		}
		return block
	})
}

async function recordGenerated(
	phase: string,
	params: Anthropic.MessageCreateParamsNonStreaming,
	response: Anthropic.Message,
	batch: boolean,
): Promise<void> {
	const usage = response.usage as ApiUsage
	const cost = computeCost(params.model, usage, { batch })
	const totalCacheWrite = usage.cache_creation_input_tokens ?? 0
	try {
		await GeneratedModel.create({
			phase,
			modelId: params.model,
			iterationId: activeIterationId,
			system: params.system ?? [],
			messages: params.messages,
			response: stripThinkingSignatures(response.content),
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheWrite5mTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? totalCacheWrite,
			cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
			cost,
			batch,
			stopReason: response.stop_reason ?? 'unknown',
		})
	} catch (err) {
		logger.error('Failed to save generated data', { error: err })
	}
}

export async function callApi(phase: Phase, messages: Anthropic.MessageParam[], tools?: Anthropic.Tool[]): Promise<Anthropic.Message> {
	const params = await buildParams(phase, messages, tools)

	// We use batch API even for single requests to achieve a 50% cost reduction.
	const customId = `req-${Date.now()}-0`
	const batch = await client.messages.batches.create({
		requests: [{ custom_id: customId, params }],
	})

	const { pollInterval, maxPollInterval, pollBackoff } = config.batch
	let delay: number = pollInterval
	let status: string = batch.processing_status

	while (status !== 'ended') {
		await new Promise(r => setTimeout(r, delay))
		const poll = await client.messages.batches.retrieve(batch.id)
		status = poll.processing_status
		if (status !== 'ended') {
			const nextDelay = Math.min(maxPollInterval, delay * pollBackoff)
			logger.debug(`Batch ${batch.id} still ${status}, retrying in ${Math.round(nextDelay / 1000)}s...`)
			delay = nextDelay
		}
	}

	const decoder = await client.messages.batches.results(batch.id)
	for await (const entry of decoder) {
		if (entry.result.type === 'succeeded') {
			const response = entry.result.message
			await recordGenerated(phase, params, response, true)
			return response
		}
		const detail = entry.result.type === 'errored'
			? JSON.stringify((entry.result as Anthropic.Messages.Batches.MessageBatchErroredResult).error)
			: entry.result.type
		throw new Error(`Batch request failed: ${detail}`)
	}

	throw new Error('Batch completed but returned no results')
}
