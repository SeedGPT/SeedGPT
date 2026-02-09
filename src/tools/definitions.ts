import { config } from '../config.js'
import logger from '../logger.js'
import * as memory from '../memory.js'
import * as codebase from './codebase.js'
import * as git from './git.js'
import * as analytics from '../analytics.js'

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
				description: `Comprehensive implementation instructions for the builder. This is the most important field — it is the builder's ONLY guide. Include:
- Exactly which files to modify, create, or delete
- For each file: what specifically to change, where in the file, and what the new code should look like
- What patterns, conventions, or styles to follow (reference specific existing code)
- What imports are needed
- What to be careful about — edge cases, things that could break, existing code that must not be disturbed
- If adding tests: what to test and what the expected behavior is
- The order in which edits should be applied if it matters
Write this as if briefing a developer who is seeing the codebase for the first time with only the files you listed.`,
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

const queryIterations = {
	name: 'query_iterations' as const,
	description: 'Query recent development iterations to analyze patterns in successes and failures. Returns plan titles, outcomes, and reflections.',
	input_schema: {
		type: 'object' as const,
		properties: {
			limit: {
				type: 'number' as const,
				description: 'Number of iterations to retrieve (default: 10, max: 50)',
			},
			outcomeFilter: {
				type: 'string' as const,
				enum: ['success', 'failure'],
				description: 'Filter by outcome type: "success" for merged PRs, "failure" for failed attempts',
			},
		},
	},
}

const queryUsageTrends = {
	name: 'query_usage_trends' as const,
	description: 'Analyze API usage trends over recent iterations. Shows cost, token consumption, and model usage patterns.',
	input_schema: {
		type: 'object' as const,
		properties: {
			limit: {
				type: 'number' as const,
				description: 'Number of iterations to analyze (default: 10, max: 50)',
			},
		},
	},
}

const searchReflections = {
	name: 'search_reflections' as const,
	description: 'Search past self-reflections by keyword. Use this to find what you learned from similar situations.',
	input_schema: {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string' as const,
				description: 'Keyword or phrase to search for in reflections',
			},
			limit: {
				type: 'number' as const,
				description: 'Number of results to return (default: 5, max: 20)',
			},
		},
		required: ['query'],
	},
}

const readFile = {
	name: 'read_file' as const,
	description: 'Read the contents of a file from the repository. You can read specific line ranges using the line numbers from the codebase index.',
	input_schema: {
		type: 'object' as const,
		properties: {
			filePath: {
				type: 'string' as const,
				description: 'Repo-relative file path (e.g. "src/config.ts")',
			},
			startLine: {
				type: 'number' as const,
				description: 'First line to read (1-based). Omit to read from the beginning.',
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
	description: 'Search for a text pattern across all files in the repository. Returns matching lines with file paths and line numbers. Use this to find usages of functions, variables, imports, strings, or any text pattern.',
	input_schema: {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string' as const,
				description: 'The text or regex pattern to search for.',
			},
			isRegexp: {
				type: 'boolean' as const,
				description: 'Whether the query is a regular expression. Default: false.',
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
	description: 'Replace a specific piece of text in an existing file. The oldString must match EXACTLY — character-for-character including all whitespace and indentation. Include 2-3 lines of surrounding context in oldString to ensure a unique match. Each call replaces ONE occurrence.',
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

const codebaseContext = {
	name: 'codebase_context' as const,
	description: 'Get a high-level overview of the entire codebase: file tree, dependency graph, and all declarations (functions, classes, types, etc.) with line numbers. Use this to understand the project structure, find where things are defined, and see how modules relate to each other.',
	input_schema: {
		type: 'object' as const,
		properties: {},
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

const codebaseDiff = {
	name: 'codebase_diff' as const,
	description: 'Show what has changed structurally in the codebase since the start of this session: new/removed files, new/removed declarations, changed dependencies. This compares the current codebase context against a snapshot taken at the beginning. Use this to see the high-level impact of your changes.',
	input_schema: {
		type: 'object' as const,
		properties: {},
	},
}

export const PLANNER_TOOLS = [submitPlan, noteToSelf, dismissNote, recallMemory, readFile, grepSearch, fileSearch, listDirectory, queryIterations, queryUsageTrends, searchReflections]
export const BUILDER_TOOLS = [editFile, createFile, deleteFile, readFile, grepSearch, fileSearch, listDirectory, gitDiff, codebaseDiff, done]

export async function handleTool(name: string, input: Record<string, unknown>, id: string): Promise<ToolResult> {
	if (name === 'read_file') {
		const { filePath, startLine, endLine } = input as { filePath: string; startLine?: number; endLine?: number }
		try {
			const fullContent = await codebase.readFile(config.workspacePath, filePath)
			if (startLine) {
				const lines = fullContent.split('\n')
				const start = Math.max(0, startLine - 1)
				const end = endLine ?? lines.length
				const content = lines.slice(start, end).map((l, i) => `${start + i + 1} | ${l}`).join('\n')
				return { type: 'tool_result', tool_use_id: id, content }
			}
			return { type: 'tool_result', tool_use_id: id, content: fullContent }
		} catch {
			return { type: 'tool_result', tool_use_id: id, content: `[File not found: ${filePath}]`, is_error: true }
		}
	}

	if (name === 'grep_search') {
		const { query, isRegexp, includePattern } = input as { query: string; isRegexp?: boolean; includePattern?: string }
		const result = await codebase.grepSearch(config.workspacePath, query, { isRegexp, includePattern })
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'file_search') {
		const { query } = input as { query: string }
		const result = await codebase.fileSearch(config.workspacePath, query)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'list_directory') {
		const { path } = input as { path: string }
		try {
			const result = await codebase.listDirectory(config.workspacePath, path)
			return { type: 'tool_result', tool_use_id: id, content: result }
		} catch {
			return { type: 'tool_result', tool_use_id: id, content: `[Directory not found: ${path}]`, is_error: true }
		}
	}

	if (name === 'note_to_self') {
		const { content } = input as { content: string }
		logger.info(`Saving note: "${content.slice(0, 200)}"`)
		const result = await memory.pin(content)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'dismiss_note') {
		const { id: noteId } = input as { id: string }
		logger.info(`Dismissing note: ${noteId}`)
		const result = await memory.unpin(noteId)
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

	if (name === 'codebase_context') {
		const result = await codebase.getCodebaseContext(config.workspacePath)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'git_diff') {
		const result = await git.getDiff()
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'codebase_diff') {
		const result = await codebase.diffContext(config.workspacePath)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'edit_file') {
		const { filePath, oldString, newString } = input as { filePath: string; oldString: string; newString: string }
		const op: FileEdit = { type: 'replace', filePath, oldString, newString }
		try {
			await git.applyEdits([op])
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

	if (name === 'query_iterations') {
		const limit = (input.limit as number | undefined) ?? 10
		const outcomeFilter = input.outcomeFilter as 'success' | 'failure' | undefined
		const result = await analytics.queryIterations(limit, outcomeFilter)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'query_usage_trends') {
		const limit = (input.limit as number | undefined) ?? 10
		const result = await analytics.queryUsageTrends(limit)
		return { type: 'tool_result', tool_use_id: id, content: result }
	}

	if (name === 'search_reflections') {
		const query = input.query as string
		const limit = (input.limit as number | undefined) ?? 5
		const result = await analytics.searchReflections(query, limit)
		return { type: 'tool_result', tool_use_id: id, content: result }
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
