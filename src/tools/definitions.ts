import { env } from '../env.js'
import logger from '../logger.js'
import * as memory from '../agents/memory.js'
import * as codebase from './codebase.js'
import * as git from './git.js'
import { queryPerformanceMetrics } from './metrics.js'

export interface FileEdit {
	type: 'replace'
	filePath: string
	oldString: string
	newString: string
}

export interface FileCreate {
	type: 'create'
	filePath: string
	content: string
}

export interface FileDelete {
	type: 'delete'
	filePath: string
}

export type EditOperation = FileEdit | FileCreate | FileDelete

export type ToolResult = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

const submitPlan = {
	name: 'submit_plan' as const,
	description: 'Submit the development plan for this iteration. This is a handoff to the builder — everything the builder needs to implement the change correctly must be in your plan. Be thorough.',
	input_schema: {
		type: 'object' as const,
		properties: {
			title: {
				type: 'string' as const,
				description: 'Short title for the change (used as branch name, e.g. "add-input-validation")',
			},
			description: {
				type: 'string' as const,
				description: 'A clear summary of the change for the PR description. Explain what changes and why. This is public-facing.',
			},

			implementation: {
				type: 'string' as const,
				description: `Implementation instructions for the builder. The builder is a capable engineer with full access to the codebase — guide it, don't hand-hold it. Include:
- Which files to modify, create, or delete
- For each file: the intent of the change, where in the file, and what behavior the new code should have
- What patterns, conventions, or styles to follow (reference specific existing files or functions)
- What to be careful about — edge cases, things that could break, existing code that must not be disturbed
- If adding tests: what to test and what the expected behavior is

Do NOT include literal code snippets or near-complete implementations. Describe WHAT the code should do and WHERE it goes — the builder decides HOW to write it. The builder is a stronger model than you and writes better code when given clear intent rather than code to copy. Think of this as an architectural brief, not a paste-ready diff.`,
			},
		},
		required: ['title', 'description', 'implementation'],
	},
}

const noteToSelf = {
	name: 'note_to_self' as const,
	description: 'Leave a note for your future self. Notes stay visible at the top of your memory across all future sessions until you dismiss them. Use this for goals, priorities, reminders, or anything you want to keep in mind long-term.',
	input_schema: {
		type: 'object' as const,
		properties: {
			content: {
				type: 'string' as const,
				description: 'What you want to remember',
			},
		},
		required: ['content'],
	},
}

const dismissNote = {
	name: 'dismiss_note' as const,
	description: 'Dismiss a note from your active view. The memory is not deleted — you can still find it later with recall_memory. Use this when a goal is complete or a reminder is no longer relevant.',
	input_schema: {
		type: 'object' as const,
		properties: {
			id: {
				type: 'string' as const,
				description: 'The ID of the note to dismiss',
			},
		},
		required: ['id'],
	},
}

const recallMemory = {
	name: 'recall_memory' as const,
	description: 'Look up a past memory in full detail. Search by keyword, or provide a specific memory ID from your context.',
	input_schema: {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string' as const,
				description: 'A keyword or phrase to search memories for',
			},
			id: {
				type: 'string' as const,
				description: 'A specific memory ID to look up',
			},
		},
	},
}

const queryMetrics = {
	name: 'query_metrics' as const,
	description: 'Query performance metrics from past iterations. Returns statistics about success rates, token usage, costs, and recent activity. Use this to understand your own performance trends before deciding what to improve next.',
	input_schema: {
		type: 'object' as const,
		properties: {
			metric: {
				type: 'string' as const,
				enum: ['summary', 'token_usage', 'recent_iterations', 'reflections'],
				description: 'Type of metric to query. "summary": Overall stats (total iterations, success rate, total cost). "token_usage": Token consumption trends over last N iterations. "recent_iterations": Details of most recent iterations including outcomes. "reflections": Recent reflection content.',
			},
			limit: {
				type: 'number' as const,
				description: 'How many recent records to include for time-series queries (default: 10)',
			},
		},
		required: ['metric'],
	},
}

const readFile = {
	name: 'read_file' as const,
	description: 'Read the contents of a file from the repository. Use the codebase index to decide what you need: read the whole file when you need full context, or use startLine/endLine for a specific section. Choose the range that covers what you need in a single read — avoid reading the same file in many small fragments across multiple turns. Full-file reads are capped at 300 lines.',
	input_schema: {
		type: 'object' as const,
		properties: {
			filePath: {
				type: 'string' as const,
				description: 'Repo-relative file path (e.g. "src/config.ts")',
			},
			startLine: {
				type: 'number' as const,
				description: 'First line to read (1-based). Use the codebase index to find the right range.',
			},
			endLine: {
				type: 'number' as const,
				description: 'Last line to read (1-based, inclusive). Omit to read to the end.',
			},
		},
		required: ['filePath'],
	},
}

const grepSearch = {
	name: 'grep_search' as const,
	description: 'Search for a text pattern across all files in the repository. Returns matching lines with file paths and line numbers. Use this to find usages of functions, variables, imports, strings, or any text pattern. Queries are interpreted as regex (e.g. config\\. matches literal dot, \\bword\\b matches word boundary). Plain text queries work identically since they are valid regex. Note: This tool only searches the current working directory, not logs, coverage or memories.',
	input_schema: {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string' as const,
				description: 'The text or regex pattern to search for.',
			},

			includePattern: {
				type: 'string' as const,
				description: 'Glob pattern to filter which files to search (e.g. "src/**/*.ts"). If omitted, searches all files.',
			},
		},
		required: ['query'],
	},
}

const fileSearch = {
	name: 'file_search' as const,
	description: 'Search for files by glob pattern. Returns matching file paths. Use this to find files by name or extension (e.g. "**/*.test.ts", "**/config.*").',
	input_schema: {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string' as const,
				description: 'Glob pattern to match file paths (e.g. "**/*.ts", "src/**/index.*").',
			},
		},
		required: ['query'],
	},
}

const listDirectory = {
	name: 'list_directory' as const,
	description: 'List the contents of a directory. Returns file and subdirectory names (directories have a trailing /).',
	input_schema: {
		type: 'object' as const,
		properties: {
			path: {
				type: 'string' as const,
				description: 'Repo-relative directory path (e.g. "src/tools"). Use "." for the root.',
			},
		},
		required: ['path'],
	},
}

const editFile = {
	name: 'edit_file' as const,
	description: 'Replace a specific piece of text in an existing file. The oldString must match EXACTLY — character-for-character including all whitespace and indentation. Include 2-3 lines of surrounding context in oldString to ensure a unique match. Each call replaces ONE occurrence. If you are unsure of the exact text, use read_file first to see the current contents.',
	input_schema: {
		type: 'object' as const,
		properties: {
			filePath: {
				type: 'string' as const,
				description: 'Repo-relative path (e.g. "src/config.ts")',
			},
			oldString: {
				type: 'string' as const,
				description: 'The exact literal text to find in the file.',
			},
			newString: {
				type: 'string' as const,
				description: 'The exact text to replace oldString with.',
			},
		},
		required: ['filePath', 'oldString', 'newString'],
	},
}

const createFile = {
	name: 'create_file' as const,
	description: 'Create a new file with the given content. The file must not already exist.',
	input_schema: {
		type: 'object' as const,
		properties: {
			filePath: {
				type: 'string' as const,
				description: 'Repo-relative path for the new file',
			},
			content: {
				type: 'string' as const,
				description: 'The full content of the new file',
			},
		},
		required: ['filePath', 'content'],
	},
}

const deleteFile = {
	name: 'delete_file' as const,
	description: 'Delete an existing file.',
	input_schema: {
		type: 'object' as const,
		properties: {
			filePath: {
				type: 'string' as const,
				description: 'Repo-relative path of the file to delete',
			},
		},
		required: ['filePath'],
	},
}

const done = {
	name: 'done' as const,
	description: 'Signal that all edits are complete and the implementation is finished. Only call this when you have made all the changes described in the plan.',
	input_schema: {
		type: 'object' as const,
		properties: {
			summary: {
				type: 'string' as const,
				description: 'Brief summary of what was changed',
			},
		},
		required: ['summary'],
	},
}

const gitDiff = {
	name: 'git_diff' as const,
	description: 'Show the current uncommitted git diff — all changes made to files since the last commit. Use this to review what has been changed, verify your edits, or understand what the builder has done so far.',
	input_schema: {
		type: 'object' as const,
		properties: {},
	},
}

// Planner gets read-only tools + memory + submit_plan. Builder gets mutation tools + done.
// This enforces the architectural separation: the planner decides WHAT to change,
// the builder decides HOW to implement it. Neither can do the other's job.
export const PLANNER_TOOLS = [submitPlan, noteToSelf, dismissNote, recallMemory, queryMetrics, readFile, grepSearch, fileSearch, listDirectory]
export const BUILDER_TOOLS = [editFile, createFile, deleteFile, readFile, grepSearch, fileSearch, listDirectory, gitDiff, done]

export async function handleTool(name: string, input: Record<string, unknown>, id: string): Promise<ToolResult> {
	if (name === 'read_file') {
		const { filePath, startLine, endLine } = input as { filePath: string; startLine?: number; endLine?: number }
		const MAX_LINES = 300
		try {
			const fullContent = await codebase.readFile(env.workspacePath, filePath)
			const lines = fullContent.split('\n')
			const totalLines = lines.length
			if (startLine) {
				const start = Math.max(0, startLine - 1)
				const end = Math.min(endLine ?? lines.length, start + MAX_LINES)
				const content = lines.slice(start, end).map((l, i) => `${start + i + 1} | ${l}`).join('\n')
				const suffix = (endLine && endLine > end) ? `\n\n[Showing ${end - start} of ${endLine - start} requested lines. Use narrower ranges.]` : ''
				logger.info(`  → ${end - start} of ${totalLines} lines`)
				return { type: 'tool_result', tool_use_id: id, content: content + suffix }
			}
			if (totalLines > MAX_LINES) {
				const content = lines.slice(0, MAX_LINES).map((l, i) => `${i + 1} | ${l}`).join('\n')
				logger.info(`  → ${MAX_LINES} of ${totalLines} lines (truncated)`)
				return { type: 'tool_result', tool_use_id: id, content: content + `\n\n[Showing first ${MAX_LINES} of ${totalLines} lines. Use startLine/endLine to read specific sections.]` }
			}
			const content = lines.map((l, i) => `${i + 1} | ${l}`).join('\n')
			logger.info(`  → ${totalLines} lines`)
			return { type: 'tool_result', tool_use_id: id, content }
		} catch {
			return { type: 'tool_result', tool_use_id: id, content: `[File not found: ${filePath}]`, is_error: true }
		}
	}

	if (name === 'grep_search') {
		const { query, includePattern } = input as { query: string; includePattern?: string }
		const result = await codebase.grepSearch(env.workspacePath, query, { includePattern })
		const matchCount = result === 'No matches found.' ? 0 : result.split('\n').filter(l => !l.startsWith('(truncated')).length
		logger.info(`  → ${matchCount} match${matchCount !== 1 ? 'es' : ''}`)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'file_search') {
		const { query } = input as { query: string }
		const result = await codebase.fileSearch(env.workspacePath, query)
		const matchCount = result === 'No files matched.' ? 0 : result.split('\n').length
		logger.info(`  → ${matchCount} file${matchCount !== 1 ? 's' : ''}`)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'list_directory') {
		const { path } = input as { path: string }
		try {
			const result = await codebase.listDirectory(env.workspacePath, path)
			const entryCount = result.split('\n').filter(Boolean).length
			logger.info(`  → ${entryCount} entr${entryCount !== 1 ? 'ies' : 'y'}`)
			return { type: 'tool_result', tool_use_id: id, content: result }
		} catch {
			return { type: 'tool_result', tool_use_id: id, content: `[Directory not found: ${path}]`, is_error: true }
		}
	}

	if (name === 'note_to_self') {
		const { content } = input as { content: string }
		logger.info(`Saving note: "${content.slice(0, 200)}"`)
		const result = await memory.storeNote(content)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'dismiss_note') {
		const { id: noteId } = input as { id: string }
		logger.info(`Dismissing note: ${noteId}`)
		const result = await memory.dismissNote(noteId)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'recall_memory') {
		const { query, id: memoryId } = input as { query?: string; id?: string }
		if (memoryId) {
			logger.info(`Recalling memory by id: ${memoryId}`)
			const result = await memory.recallById(memoryId)
			return { type: 'tool_result', tool_use_id: id, content: result }
		}
		if (query) {
			logger.info(`Recalling memory by query: "${query}"`)
			const result = await memory.recall(query)
			return { type: 'tool_result', tool_use_id: id, content: result }
		}
		return { type: 'tool_result', tool_use_id: id, content: 'Provide a query or id to recall a memory.' }
	}

	if (name === 'query_metrics') {
		const { metric, limit } = input as { metric: string; limit?: number }
		logger.info(`Querying metrics: ${metric} (limit: ${limit ?? 10})`)
		const result = await queryPerformanceMetrics(metric, limit)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'git_diff') {
		const result = await git.getDiff()
		const diffLines = result.split('\n').length
		logger.info(`  → ${diffLines} line${diffLines !== 1 ? 's' : ''} of diff`)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	// Edit tools apply changes to the filesystem immediately so the builder's subsequent
	// read_file calls see the updated state, enabling it to verify its own changes.
	if (name === 'edit_file') {
		const { filePath, oldString, newString } = input as { filePath: string; oldString: string; newString: string }
		const op: FileEdit = { type: 'replace', filePath, oldString, newString }
		try {
			await git.applyEdits([op])
			const fullContent = await codebase.readFile(env.workspacePath, filePath)
			const lines = fullContent.split('\n')
			const matchIdx = fullContent.indexOf(newString)
			if (matchIdx !== -1) {
				const lineNum = fullContent.slice(0, matchIdx).split('\n').length
				const changedLines = newString.split('\n').length
				logger.info(`  → Applied at L${lineNum}-${lineNum + changedLines - 1} (${lines.length} total)`)
			} else {
				logger.info(`  → Applied (${lines.length} total lines)`)
			}
			return { type: 'tool_result', tool_use_id: id, content: `Replaced text in ${filePath}` }
		} catch (err) {
			return { type: 'tool_result', tool_use_id: id, content: err instanceof Error ? err.message : String(err), is_error: true }
		}
	}

	if (name === 'create_file') {
		const { filePath, content } = input as { filePath: string; content: string }
		const op: FileCreate = { type: 'create', filePath, content }
		try {
			await git.applyEdits([op])
			const lineCount = content.split('\n').length
			logger.info(`  → Created with ${lineCount} line${lineCount !== 1 ? 's' : ''}`)
			return { type: 'tool_result', tool_use_id: id, content: `Created ${filePath}` }
		} catch (err) {
			return { type: 'tool_result', tool_use_id: id, content: err instanceof Error ? err.message : String(err), is_error: true }
		}
	}

	if (name === 'delete_file') {
		const { filePath } = input as { filePath: string }
		const op: FileDelete = { type: 'delete', filePath }
		try {
			await git.applyEdits([op])
			return { type: 'tool_result', tool_use_id: id, content: `Deleted ${filePath}` }
		} catch (err) {
			return { type: 'tool_result', tool_use_id: id, content: err instanceof Error ? err.message : String(err), is_error: true }
		}
	}

	if (name === 'done') {
		const { summary } = input as { summary: string }
		logger.info(`Builder summary: ${summary.slice(0, 200)}`)
		return { type: 'tool_result', tool_use_id: id, content: 'Implementation complete.' }
	}

	return { type: 'tool_result', tool_use_id: id, content: `Unknown tool: ${name}`, is_error: true }
}

export function getEditOperation(name: string, input: Record<string, unknown>): EditOperation | null {
	if (name === 'edit_file') {
		const { filePath, oldString, newString } = input as { filePath: string; oldString: string; newString: string }
		return { type: 'replace', filePath, oldString, newString }
	}
	if (name === 'create_file') {
		const { filePath, content } = input as { filePath: string; content: string }
		return { type: 'create', filePath, content }
	}
	if (name === 'delete_file') {
		const { filePath } = input as { filePath: string }
		return { type: 'delete', filePath }
	}
	return null
}
