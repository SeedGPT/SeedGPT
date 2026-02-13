import IterationLogModel from './models/IterationLog.js'

type Level = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
	timestamp: string
	level: Level
	message: string
	context?: Record<string, unknown>
}

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? 'info'

// All log entries are buffered in-memory across the entire iteration, then flushed
// to MongoDB at the end. This serves double duty: the reflection step reads the buffer
// to understand what happened, and writeIterationLog persists it for debugging.
const logBuffer: LogEntry[] = []

function log(level: Level, message: string, context?: Record<string, unknown>): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return
	const timestamp = new Date().toISOString()
	logBuffer.push({ timestamp, level, message, context })
	const prefix = `${timestamp} [${level.toUpperCase()}]`
	if (context) {
		console.log(`${prefix} ${message}`, JSON.stringify(context, null, 2))
	} else {
		console.log(`${prefix} ${message}`)
	}
}

export async function writeIterationLog(tokenUsage?: {
	planner: { input: number; output: number; cost: number }
	builder: { input: number; output: number; cost: number }
	reflect: { input: number; output: number; cost: number }
	total: { input: number; output: number; cost: number }
}): Promise<void> {
	try {
		await IterationLogModel.create({
			entries: logBuffer.map(e => ({
				timestamp: e.timestamp,
				level: e.level,
				message: e.message,
				context: e.context,
			})),
			tokenUsage,
		})
		log('info', 'Iteration log saved to database')
	} catch (err) {
		log('error', 'Failed to save iteration log', { error: err })
	}
	logBuffer.length = 0
}

export function getLogBuffer(): readonly LogEntry[] {
	return logBuffer
}

export function toolLogSuffix(block: { name: string; input: unknown }): string {
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

const logger = {
	debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
}

export default logger
