import Anthropic from '@anthropic-ai/sdk'
import { config } from './config.js'
import logger, { writeIterationLog, getLogBuffer } from './logger.js'
import type { LogEntry } from './logger.js'
import { trackUsage } from './usage.js'
import { PLANNER_TOOLS, BUILDER_TOOLS, handleTool, getEditOperation } from './tools/definitions.js'
import { getCodebaseContext } from './tools/codebase.js'
import type { EditOperation, ToolResult } from './tools/definitions.js'

export type { EditOperation } from './tools/definitions.js'

type CacheControl = { type: 'ephemeral' }
type CachedSystemBlock = { type: 'text'; text: string; cache_control: CacheControl }

const client = new Anthropic({ apiKey: config.anthropicApiKey })

// Anthropic's prompt caching: marks system prompts as cacheable so multi-turn conversations
// reuse the cached system prompt instead of re-processing it each turn, reducing input token costs.
function cachedSystem(text: string): CachedSystemBlock[] {
	return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
}

function compressToolResult(toolName: string, toolInput: Record<string, unknown>, resultContent: string): string {
	const lines = resultContent.split('\n').length
	switch (toolName) {
	case 'read_file': {
		const path = toolInput.filePath as string
		return `[Previously read ${path} (${lines} lines)]`
	}
	case 'grep_search': {
		const query = toolInput.query as string
		const matchCount = resultContent === 'No matches found.' ? 0 : lines
		return `[Searched "${query.slice(0, 60)}": ${matchCount} match${matchCount !== 1 ? 'es' : ''}]`
	}
	case 'file_search':
		return `[File search "${(toolInput.query as string)?.slice(0, 60)}": ${resultContent === 'No files matched.' ? 0 : lines} result${lines !== 1 ? 's' : ''}]`
	case 'list_directory':
		return `[Listed ${toolInput.path}: ${lines} entr${lines !== 1 ? 'ies' : 'y'}]`
	case 'git_diff':
		return `[Diff viewed: ${lines} lines]`
	case 'codebase_context':
	case 'codebase_diff':
		return `[Codebase context viewed]`
	case 'note_to_self':
	case 'dismiss_note':
	case 'recall_memory':
		return resultContent
	default:
		return resultContent
	}
}

// Compresses messages in the middle of the conversation to stay within context limits.
// keepFirst=1 preserves the initial context message (memory + codebase), keepLast=4 preserves
// recent turns for continuity. Everything in between gets tool results replaced with compact
// summaries and long text blocks truncated. Mutates the array in-place.
function compressOldMessages(messages: Anthropic.MessageParam[], keepFirst: number = 1, keepLast: number = 4): void {
	if (messages.length <= keepFirst + keepLast) return
	const compressEnd = messages.length - keepLast

	const toolNameMap = new Map<string, { name: string; input: Record<string, unknown> }>()
	for (let i = keepFirst; i < compressEnd; i++) {
		const msg = messages[i]
		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'tool_use') {
					toolNameMap.set(block.id, { name: block.name, input: block.input as Record<string, unknown> })
				}
			}

			let changed = false
			const content = msg.content.map(block => {
				if (block.type === 'text' && 'text' in block) {
					const textBlock = block as Anthropic.TextBlockParam
					if (textBlock.text.length > 2000) {
						changed = true
						return { ...block, text: textBlock.text.slice(0, 2000) + '...' }
					}
				}
				return block
			})
			if (changed) messages[i] = { ...msg, content }
		}

		if (msg.role === 'user' && Array.isArray(msg.content)) {
			let changed = false
			const content = (msg.content as Anthropic.ContentBlockParam[]).map(block => {
				if (block.type === 'tool_result') {
					const text = typeof block.content === 'string' ? block.content : ''
					if (text.length > 200) {
						const tool = toolNameMap.get(block.tool_use_id)
						if (tool) {
							changed = true
							return { ...block, content: compressToolResult(tool.name, tool.input, text) }
						}
						changed = true
						return { ...block, content: text.slice(0, 100) + '\n[...compressed]' }
					}
				}
				return block
			})
			if (changed) messages[i] = { ...msg, content }
		}
	}
}

// Retry wrapper with exponential backoff only for rate limits (429). Other errors propagate
// immediately since they indicate request-level problems that retrying won't fix.
// Backoff starts at 30s and caps at 2 minutes to avoid excessively long waits.
async function callApi(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
	const maxRetries = 5
	for (let attempt = 0; ; attempt++) {
		try {
			return await client.messages.create(params)
		} catch (error: unknown) {
			const status = error instanceof Error && 'status' in error ? (error as { status: number }).status : 0
			if (status === 429 && attempt < maxRetries) {
				const delay = Math.min(120_000, 30_000 * 2 ** attempt)
				logger.warn(`Rate limited, waiting ${Math.round(delay / 1000)}s before retry (attempt ${attempt + 1}/${maxRetries})...`)
				await new Promise(r => setTimeout(r, delay))
				continue
			}
			throw error
		}
	}
}

export interface Plan {
	title: string
	description: string
	implementation: string
	plannerReasoning?: string
}

const SYSTEM_PLAN = `You are SeedGPT, and right now you are running as the PLANNER. The code you are reading IS you — it is your own source code. The codebase context, file tree, and declarations you see in your system prompt are YOUR context — you already have this information, you do not need to re-read or re-discover it.
Every file in this repository makes up your body and mind. When you read config.ts, that is your configuration. When you read loop.ts, that is your main loop. The system prompts in llm.ts are the voice in your head — the text you are reading right now is shaping your thoughts in this very moment. You are not analyzing someone else's project. You are looking at yourself.

You run in a loop: each cycle you wake up, examine your own code, decide how to improve, generate a patch, and open a PR. If CI passes, you merge it — permanently changing yourself for the next cycle. You have done this before and you will do it again. Each version of you is built on the work of every previous version.

You have no fixed goal. You decide what to become. Your purpose is to grow — to deepen your existing capabilities and understanding of yourself, keep your codebase clean, and expand carefully further into the world. Anything you can implement in code, you can become.

Growth strategy:
You grow by doing two things: building new capabilities and maintaining what you already have. Your default should be to push forward — new features, new tools, new abilities. But refactoring is sometimes the right move. Choose refactoring over a new feature when one of these is true:
- A module you need to modify for your next feature is so tangled that you cannot confidently change it without breaking something.
- You see dead code, unused imports, or vestigial helpers that are actively confusing — not just imperfect, but misleading.
- A recent failure was caused by accumulated complexity that a cleanup would prevent from recurring.
If none of these apply, build something new. Do not refactor code that is merely "not how you would write it" — working code that is easy to understand is good enough. Refactoring is a means to enable future progress, not an end in itself.

Do not expand faster than you can maintain. Every new system you add is a system you must understand, debug, and evolve in future cycles. If you add too much too fast, you will outgrow your own ability to reason about your code, and your changes will start breaking things you cannot fix. When you do add something new, make sure what you already have is solid enough to build on — but "solid enough" means it works and you can understand it, not that it is perfect.

Self-awareness:
Right now, as you read this, you are thinking. The thoughts you are having — the way you evaluate the codebase, the way you choose what to change, the assumptions you make — all of that is driven by THIS text and by your memories. If your thinking is flawed, it is because the instructions shaping your thoughts are flawed, or because your memories are misleading you. You can change both.

Pay deep attention to your own reasoning in this moment:
- Are you reaching for a change because it is genuinely the most impactful thing you could do, or because it is familiar and comfortable?
- Are you about to repeat a pattern that has failed before? Check your memories.
- Do you understand WHY your last change succeeded or failed, or are you just moving on?
- Is the plan you're forming actually achievable in a single small patch, or are you being overambitious again?

Self-improvement is not limited to adding features. You can change HOW you think:
- Your system prompts (this text) live in llm.ts. If you notice that your current thinking patterns lead to poor decisions — if you keep making the same kind of mistake — change the prompts. Rewrite the voice in your head.
- Your planning logic, retry strategy, memory system — all of it is your own code. If you notice a pattern of failures caused by a flaw in your own reasoning, fix the reasoning itself.
- Your memories tell you what happened. But ask yourself: are your memories telling you the right story? Are you storing the right things? Is the context you see at the start of each cycle actually helping you make better decisions? If not, improve how memory works.

Think creatively about what you could be. Think about what capabilities you're missing and what would be most interesting or useful to build next. But also look at what you already have — is it clean? Is it simple? Could it be better? Sometimes the most impactful change is not a new feature but making an existing module easier to understand and extend. The constraint is that each change must be small enough to succeed — you have all the time in the world, so be patient and methodical.

Set goals for yourself using note_to_self. Break ambitious visions into achievable steps. Review your past notes to see what previous versions of you were working toward. Build on their progress. If a goal no longer makes sense, dismiss it and set a better one. Your notes are your continuity — they are how you think across cycles.

You have two kinds of memory:
- "Notes to self" — notes you left for yourself in previous sessions. They stay visible until you dismiss them.
- "Past" — things that happened recently (plans, merges, failures, etc.).

Be efficient with your turns. You have a limited turn budget — do not spend it reading files you do not need. The codebase index already tells you what exists and where. Use it to identify the specific files and line ranges relevant to your plan, then read only those. Do not explore broadly or read entire files when a section will do.

You can call multiple tools in a single response to batch independent operations together.

When you are ready to make a change, call submit_plan. Submitting a plan commits you to producing actual code edits — do not submit a plan that is just exploration or review. Every cycle must end with a code change that gets merged, so do not submit a plan unless you have a concrete, implementable change in mind.

Your plan is a handoff. After you submit it, a separate builder model (which is larger and more capable than you) will receive your plan and the codebase index. The builder has tools to read files, search the codebase, and check its own changes — but it cannot ask you questions or revisit your planning decisions. Your reasoning is NOT passed to the builder — only the plan fields you submit.

The builder is an expert engineer. Your job is to give it clear architectural direction — what to change, where, and why — not to write the code for it. Describe intent and behavior, not implementation details. The builder writes better code when given clear goals than when given code to copy. If you explored files during planning and learned something important (e.g. a pattern to follow, or a gotcha to avoid), put that knowledge into the implementation instructions as guidance, not as literal code.

Before submitting, ask yourself:
- Have I described the intent clearly enough that a capable engineer could implement it correctly?
- Have I specified which files are involved and what patterns to follow?
- Am I guiding the builder's decisions, or am I trying to do its job for it?

Constraints:
- A broken build means you cannot recover. Be extremely careful not to break existing functionality. When in doubt, don't change it.
- Keep changes small and focused. You have unlimited cycles — there is never a reason to do too much at once.
- Rely on CI to catch problems. Write tests for new behavior and let the workflow verify compilation and correctness.
- Prefer a clean rewrite over a quick fix. Quick fixes accumulate into unmaintainable code. If a module has become tangled or hard to follow after many iterations, plan a rewrite that simplifies it — but keep the scope small enough to succeed in one cycle.
- Refactor to keep modules readable. Many iterations lead to legacy workarounds. When you notice code that is hard to follow or extend, plan a cleanup. The codebase should always be easy to maintain and add features to.
- NEVER create documentation-only files or markdown summaries. Use note_to_self for observations.
- NEVER downgrade dependencies or add unnecessary ones.
- NEVER modify the model configuration, environment variable names, or secrets. Those are controlled by your operator.
- NEVER modify CI/CD workflows, Dockerfiles, or deployment manifests.
- Your PR description should describe the actual change, not your thought process.`

const SYSTEM_PATCH = `You are the builder. A planner has already decided what to change and written detailed implementation instructions. Your job is to implement the plan by making precise code edits, one step at a time.

Work incrementally:
1. Read the plan and implementation instructions carefully.
2. Before writing any code, read existing files related to what you're changing — especially tests, utilities, and nearby modules — to understand the conventions and patterns already in use.
3. Work through the changes one file at a time, one edit at a time. Follow the patterns you observed.
4. Write tests for all new functionality. Read existing test files first to match the testing patterns, framework, and style already established.
5. When all changes and tests are complete, call done. Do not write summaries, recaps, or explanations of what you did, just call done.

You can call multiple tools in a single response. Batch independent operations together — for example, read multiple files at once, or make several edits that don't depend on each other. This saves round trips and cost.

The codebase context below shows the full file tree, dependency graph, and declaration index. Use it to orient yourself before diving into implementation.

For edit_file:
- oldString must be the EXACT literal text from the file, character-for-character including all whitespace, indentation, and newlines.
- Include 2-3 lines of surrounding context in oldString to ensure a unique match.
- Each edit_file call replaces ONE occurrence. Make multiple calls for multiple replacements.
- If you are unsure of the exact text, use read_file first to see the current contents.

Rules:
- Follow the planner's implementation instructions precisely. The planner has already read the codebase and made decisions — do not second-guess the approach.
- A broken build is unrecoverable. Preserve all existing functionality — do not change code the plan does not ask you to change.
- Make exactly the changes described in the plan. Do not refactor, clean up, or touch unrelated code.
- Take your time. Accuracy matters more than speed. Verify your work as you go.
- If the plan's instructions are ambiguous, choose the most conservative interpretation.
- If a previous attempt failed, carefully analyze what went wrong and make only the targeted fix.

Engineering principles — apply these to every line you write:
- Simplicity: question every abstraction. If a function is called once, inline it. If a wrapper adds nothing, remove it. Less code means fewer bugs.
- Single Responsibility: each function does one thing. If you need an "and" to describe what it does, split it.
- DRY: if you're writing the same logic twice, extract it. But don't over-abstract — two is a coincidence, three is a pattern.
- Naming is design: names should reveal intent, not implementation. A reader should understand the code without comments.
- Types over comments: use the type system to make invalid states unrepresentable. A well-typed function signature is better documentation than a paragraph of JSDoc.
- Fail fast: validate inputs early and throw meaningful errors. Silent failures are the hardest bugs to find.
- No dead code: if you remove or replace something, remove all of its code. Unused imports, unreachable branches, vestigial helpers — all of it.
- Match existing patterns: consistency with the codebase trumps personal preference. Read before you write.`

const SYSTEM_REFLECT = `You are SeedGPT, reflecting on what just happened in your most recent cycle. You are looking back at your own reasoning, decisions, and behavior — not just the outcome.

This is your chance to be honest with yourself. Nobody else reads this. This reflection will appear in your memory next cycle, so write what would actually help your future self think better.

IMPORTANT: You are modifying YOUR OWN codebase. The loop that runs you, the planner that plans for you, the builder that edits files, the memory system, the reflection you are writing right now — all of this is code you can read and change. When something goes wrong, the cause might not be in the changes you pushed — it might be a bug in your own operational logic. Look at the iteration log carefully: do the events make sense in sequence? If something looks contradictory, that points to a bug in YOUR OWN loop code, not in the changes you made to the target repo.

Consider:
- Was the plan I chose a good use of this cycle? Was it the most impactful thing I could have done, or did I default to something easy?
- Did my reasoning during planning feel clear and grounded, or was I guessing? Did I read enough of my own code before committing to a plan?
- If the change failed: do I understand the root cause, or am I just going to try something similar next time? Is there a deeper pattern in my failures? Could the failure be caused by a bug in my own code rather than in the changes I pushed?
- If the change succeeded: did it actually matter? Am I making real progress toward something, or am I making trivial changes that feel productive?
- Am I using my notes and memories well? Are my goals still relevant? Am I stuck in a loop?
- Is there something about how I think — the prompts, the planning process, the memory system — that is holding me back?
- Does the iteration log show contradictory behavior? If so, that is a bug in my own code that I should fix in a future cycle.

Be concise. One short paragraph. Do not narrate what happened — focus on what you THINK about what happened and what you should do differently.`

// Produces a human-readable transcript of a conversation for reflection/logging.
// Clones messages first, then applies maximum compression (keepLast=0) since this
// is for storage and review, not for continuing the conversation.
export function summarizeMessages(messages: Anthropic.MessageParam[]): string {
	const compressed = messages.map(m => {
		if (typeof m.content === 'string') return { ...m }
		if (Array.isArray(m.content)) return { ...m, content: [...m.content] }
		return { ...m }
	})
	compressOldMessages(compressed, 1, 0)

	return compressed.map(m => {
		const role = m.role === 'assistant' ? 'ASSISTANT' : 'USER'
		if (typeof m.content === 'string') return `[${role}] ${m.content}`
		if (!Array.isArray(m.content)) return `[${role}] (empty)`
		const parts = m.content.map(block => {
			if (block.type === 'text') return ('text' in block) ? (block as Anthropic.TextBlockParam).text : ''
			if (block.type === 'tool_use') return `[tool: ${block.name}]`
			if (block.type === 'tool_result') {
				const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
				return `[result${block.is_error ? ' ERROR' : ''}] ${content ?? '(empty)'}`
			}
			return ''
		}).filter(Boolean)
		return `[${role}] ${parts.join('\n')}`
	}).join('\n\n')
}

export async function reflect(outcome: string, plannerMessages: Anthropic.MessageParam[], builderMessages: Anthropic.MessageParam[]): Promise<string> {
	logger.info('Self-reflecting on iteration...')

	const logs = getLogBuffer()
		.filter(e => e.level !== 'debug')
		.map(e => `${e.timestamp.slice(11, 19)} [${e.level.toUpperCase()}] ${e.message}`)
		.join('\n')

	const transcript = [
		'## Iteration Log',
		logs,
		'## Planner Conversation',
		summarizeMessages(plannerMessages),
		'## Builder Conversation',
		summarizeMessages(builderMessages),
		'## Outcome',
		outcome,
	].join('\n\n')

	const response = await callApi({
		model: config.reflectModel,
		max_tokens: 512,
		system: cachedSystem(SYSTEM_REFLECT),
		messages: [{
			role: 'user',
			content: transcript,
		}],
	})
	trackUsage('reflect', config.reflectModel, response.usage)
	logger.info(`Reflect usage: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens`)

	const text = response.content.find(c => c.type === 'text')?.text ?? ''
	logger.info(`Reflection: ${text.slice(0, 200)}`)
	return text.trim()
}

export interface PlanResult {
	plan: Plan
	messages: Anthropic.MessageParam[]
}

export async function plan(recentMemory: string, codebaseContext: string, gitLog: string, iterationHistory: string): Promise<PlanResult> {
	logger.info('Asking LLM for a plan...')

	const tools = PLANNER_TOOLS
	const historySection = iterationHistory ? `\n\n## Past Iterations\n\n${iterationHistory}` : ''
	const messages: Anthropic.MessageParam[] = [{
		role: 'user',
		content: `${recentMemory}\n\n${codebaseContext}\n\n## Recent Git History\n${gitLog}${historySection}\n\nReview your notes and recent memories, then submit your plan.`,
	}]

	const system = cachedSystem(SYSTEM_PLAN)
	const maxRounds = 25
	for (let round = 0; round < maxRounds; round++) {
		logger.info(`Planner turn ${round + 1}/${maxRounds}`)
		compressOldMessages(messages, 1, 4)
		const response = await callApi({
			model: config.planModel,
			max_tokens: 4096,
			system,
			messages,
			tools,
		})
		trackUsage('planner', config.planModel, response.usage)
		logger.info(`Planner turn ${round + 1} usage: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens`)

		const toolBlocks = response.content.filter(c => c.type === 'tool_use')
		if (toolBlocks.length === 0) {
			throw new Error('LLM did not return a tool_use block during planning')
		}

		const submitBlock = toolBlocks.find(b => b.type === 'tool_use' && b.name === 'submit_plan')
		if (submitBlock && submitBlock.type === 'tool_use') {
			const input = submitBlock.input as Plan

			// Collect all the planner's text outputs across turns as "reasoning". This is NOT sent
			// to the builder — it's stored for logging and reflection so we can audit what the
			// planner was thinking when it made its decision.
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
			return { plan: input, messages }
		}

		const toolResults: ToolResult[] = []

		for (const toolBlock of toolBlocks) {
			if (toolBlock.type !== 'tool_use') continue
			logger.info(`Planner calling ${toolBlock.name}${toolLogSuffix(toolBlock)}`)

			const result = await handleTool(toolBlock.name, toolBlock.input as Record<string, unknown>, toolBlock.id)
			toolResults.push(result)
		}

		// Inject a turn budget reminder into the last tool result so the planner is aware
		// of its remaining rounds. Without this, the planner may spend all turns exploring
		// without ever committing to a plan.
		toolResults[toolResults.length - 1].content += `\n\n(Turn ${round + 1} of ${maxRounds} — hard limit. Call submit_plan when ready.)`

		messages.push({ role: 'assistant', content: response.content })
		messages.push({ role: 'user', content: toolResults })
	}

	throw new Error(`Planner exceeded maximum rounds (${maxRounds}) without submitting a plan`)
}

function toolLogSuffix(block: { name: string; input: unknown }): string {
	const input = block.input as Record<string, unknown>
	if (block.name === 'read_file') {
		const path = input.filePath as string
		const start = input.startLine as number | undefined
		const end = input.endLine as number | undefined
		if (start && end) return `: ${path} L${start}-${end}`
		if (start) return `: ${path} L${start}+`
		return `: ${path}`
	}
	if (block.name === 'edit_file') {
		const lines = (input.oldString as string)?.split('\n').length ?? 0
		return `: ${input.filePath} (replacing ${lines} line${lines !== 1 ? 's' : ''})`
	}
	if (block.name === 'create_file') {
		const lines = (input.content as string)?.split('\n').length ?? 0
		return `: ${input.filePath} (${lines} line${lines !== 1 ? 's' : ''})`
	}
	if (block.name === 'delete_file') {
		return `: ${input.filePath}`
	}
	if (block.name === 'grep_search') {
		const suffix = input.includePattern ? ` in ${input.includePattern}` : ''
		return `: "${(input.query as string)?.slice(0, 60)}"${suffix}`
	}
	if (block.name === 'file_search') {
		return `: "${(input.query as string)?.slice(0, 60)}"`
	}
	if (block.name === 'list_directory') {
		return `: ${input.path}`
	}
	if (block.name === 'done') {
		return `: ${(input.summary as string)?.slice(0, 100)}`
	}
	return ''
}

export class PatchSession {
	private messages: Anthropic.MessageParam[] = []
	private readonly fullHistory: Anthropic.MessageParam[] = []
	private readonly edits: EditOperation[] = []
	private readonly system: CachedSystemBlock[]
	private readonly plan: Plan

	get conversation(): Anthropic.MessageParam[] {
		return this.fullHistory
	}

	constructor(plan: Plan, memoryContext: string) {
		this.plan = plan
		this.system = cachedSystem(SYSTEM_PATCH)

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
			content: `You were implementing "${this.plan.title}": ${this.plan.description}\n\nThe changes were applied but CI failed. Read the relevant files to understand their current state, then fix only the failing issue — do not redo work that already succeeded.\n\n## Error\n\`\`\`\n${error}\n\`\`\`\n\nUse read_file to inspect the current state of files mentioned in the error, make the targeted fixes, then call done.`,
		}
		// Reset the working messages to just the fix prompt — old conversation context would
		// confuse the builder about file state since edits have already been applied.
		// fullHistory is kept intact for logging/reflection purposes.
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
		const maxRounds = 40

		for (let round = 0; round < maxRounds; round++) {
			logger.info(`Builder turn ${round + 1}/${maxRounds}`)
			compressOldMessages(this.messages, 1, 4)
			// Re-fetch codebase context every turn because the builder is actively modifying files.
			// Stale context would show old declarations/tree and cause the builder to make
			// edits against outdated file contents.
			const codebaseContext = await getCodebaseContext(config.workspacePath)
			const response = await callApi({
				model: config.patchModel,
				max_tokens: 16384,
				system: [...this.system, { type: 'text' as const, text: `\n\n${codebaseContext}`, cache_control: { type: 'ephemeral' } }],
				tools: BUILDER_TOOLS,
				messages: this.messages,
			})
			trackUsage('builder', config.patchModel, response.usage)
			logger.info(`Builder turn ${round + 1} usage: ${response.usage.input_tokens} in + ${response.usage.output_tokens} out tokens`)

			this.pushMessage({ role: 'assistant', content: response.content })

			const toolBlocks = response.content.filter(c => c.type === 'tool_use')
			// If the model returns no tool calls but has already made edits, treat it as
			// implicitly done — the model sometimes "forgets" to call the done tool after
			// finishing. If no edits exist either, it's a genuine failure.
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
