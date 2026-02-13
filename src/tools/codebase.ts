import { readdir, readFile as fsReadFile } from 'fs/promises'
import { join, extname, dirname, posix } from 'path'
import ts from 'typescript'

const IGNORE = new Set(['node_modules', '.git', 'dist', 'logs', '.tmp-patch.diff', 'package-lock.json'])
const TS_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs'])

export async function getCodebaseContext(rootPath: string): Promise<string> {
	const tasks: [Promise<string>, Promise<string>, Promise<string>?] = [
		getFileTree(rootPath),
		getDeclarationIndex(rootPath),
	]
	const [tree, declarations] = await Promise.all(tasks)

	const sections = [`## File Tree\n\`\`\`\n${tree}\n\`\`\``]
	sections.push(`## Declarations\n${declarations}`)
	return sections.join('\n\n')
}

export async function getFileTree(rootPath: string): Promise<string> {
	const lines: string[] = ['.']
	await walkTree(rootPath, '', lines)
	return lines.join('\n')
}

export async function getDeclarationIndex(rootPath: string): Promise<string> {
	const allFiles: string[] = []
	await walk(rootPath, '', allFiles)

	const sections: string[] = []
	for (const relPath of allFiles) {
		if (relPath.endsWith('/')) continue
		const ext = extname(relPath)

		if (isTestFile(relPath)) continue

		if (TS_EXTENSIONS.has(ext)) {
			try {
				const content = await fsReadFile(join(rootPath, relPath), 'utf-8')
				const lineCount = content.split('\n').length
				const declarations = extractDeclarations(content, relPath, { exportedOnly: true })
				const header = `### ${relPath} (${lineCount} lines)`
				sections.push(declarations.length > 0 ? `${header}\n${declarations.join('\n')}` : header)
			} catch { /* skip unreadable */ }
		} else if (ext === '.json') {
			try {
				const content = await fsReadFile(join(rootPath, relPath), 'utf-8')
				const lineCount = content.split('\n').length
				sections.push(`### ${relPath} (${lineCount} lines)`)
			} catch { /* skip */ }
		}
	}

	return sections.join('\n\n')
}

export interface ExtractOptions {
	exportedOnly?: boolean
}

export function extractDeclarations(sourceText: string, filePath: string, options?: ExtractOptions): string[] {
	const kind = filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
	const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, kind)
	const expOnly = options?.exportedOnly ?? false
	const lines: string[] = []
	for (const stmt of sf.statements) visitNode(sf, stmt, lines, '  ', expOnly)
	return lines
}

function visitNode(sf: ts.SourceFile, node: ts.Node, out: string[], indent: string, expOnly: boolean): void {
	const exported = isExported(node)
	if (expOnly && !exported) return

	const range = lineRange(sf, node)
	const exp = exported ? 'export ' : ''

	if (ts.isFunctionDeclaration(node) && node.name) {
		const a = mod(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''
		out.push(`${indent}${exp}${a}function ${node.name.text}  [${range}]`)
	} else if (ts.isClassDeclaration(node) && node.name) {
		out.push(`${indent}${exp}class ${node.name.text}  [${range}]`)
	} else if (ts.isInterfaceDeclaration(node)) {
		out.push(`${indent}${exp}interface ${node.name.text}  [${range}]`)
	} else if (ts.isTypeAliasDeclaration(node)) {
		const text = node.type.getText(sf)
		const short = text.length < 80 ? ` = ${text}` : ''
		out.push(`${indent}${exp}type ${node.name.text}${short}  [${range}]`)
	} else if (ts.isEnumDeclaration(node)) {
		const members = node.members.map(m => m.name.getText(sf)).join(', ')
		out.push(`${indent}${exp}enum ${node.name.text} { ${members} }  [${range}]`)
	} else if (ts.isVariableStatement(node)) {
		const keyword = node.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let'
		for (const d of node.declarationList.declarations) {
			if (!ts.isIdentifier(d.name)) continue
			out.push(`${indent}${exp}${keyword} ${d.name.text}  [${range}]`)
		}
	}
}

function visitClassMember(sf: ts.SourceFile, node: ts.Node, out: string[], indent: string, expOnly: boolean): void {
	if (expOnly && mod(node, ts.SyntaxKind.PrivateKeyword)) return

	const range = lineRange(sf, node)
	const access = mod(node, ts.SyntaxKind.PrivateKeyword) ? 'private '
		: mod(node, ts.SyntaxKind.ProtectedKeyword) ? 'protected ' : ''
	const s = mod(node, ts.SyntaxKind.StaticKeyword) ? 'static ' : ''
	const ro = mod(node, ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : ''
	const a = mod(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''

	if (ts.isConstructorDeclaration(node)) {
		out.push(`${indent}constructor(${params(sf, node)})  [${range}]`)
	} else if (ts.isMethodDeclaration(node) && node.name) {
		out.push(`${indent}${access}${s}${a}${node.name.getText(sf)}(${params(sf, node)})${retType(sf, node)}  [${range}]`)
	} else if (ts.isPropertyDeclaration(node) && node.name) {
		const type = node.type ? `: ${node.type.getText(sf)}` : ''
		out.push(`${indent}${access}${s}${ro}${node.name.getText(sf)}${type}  [${range}]`)
	}
}

function visitTypeMember(sf: ts.SourceFile, node: ts.Node, out: string[], indent: string): void {
	if (ts.isPropertySignature(node) && node.name) {
		const opt = node.questionToken ? '?' : ''
		const type = node.type ? `: ${node.type.getText(sf)}` : ''
		out.push(`${indent}${node.name.getText(sf)}${opt}${type}`)
	} else if (ts.isMethodSignature(node) && node.name) {
		const p = node.parameters.map(p => {
			const dots = p.dotDotDotToken ? '...' : ''
			const name = p.name.getText(sf)
			const opt = p.questionToken ? '?' : ''
			const type = p.type ? `: ${p.type.getText(sf)}` : ''
			return `${dots}${name}${opt}${type}`
		}).join(', ')
		const ret = node.type ? `: ${node.type.getText(sf)}` : ''
		out.push(`${indent}${node.name.getText(sf)}(${p})${ret}`)
	}
}

function params(sf: ts.SourceFile, node: ts.FunctionLikeDeclaration): string {
	return node.parameters.map(p => {
		const dots = p.dotDotDotToken ? '...' : ''
		const name = p.name.getText(sf)
		const opt = p.questionToken ? '?' : ''
		const type = p.type ? `: ${p.type.getText(sf)}` : ''
		return `${dots}${name}${opt}${type}`
	}).join(', ')
}

function retType(sf: ts.SourceFile, node: ts.FunctionLikeDeclaration): string {
	return node.type ? `: ${node.type.getText(sf)}` : ''
}

function lineRange(sf: ts.SourceFile, node: ts.Node): string {
	const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
	const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
	return start === end ? `L${start}` : `L${start}-${end}`
}

function isExported(node: ts.Node): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

function isTestFile(relPath: string): boolean {
	return /\.(test|spec)\.[tj]sx?$/.test(relPath)
}

function mod(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(m => m.kind === kind) ?? false)
}

// When no explicit type annotation exists, infers a readable type approximation from
// the initializer AST node. This gives the codebase index useful type hints for the
// planner even when the codebase uses type inference heavily.
function inferType(sf: ts.SourceFile, init: ts.Expression | undefined): string {
	if (!init) return ''
	if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) || ts.isTemplateExpression(init)) return ': string'
	if (ts.isNumericLiteral(init)) return ': number'
	if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) return ': boolean'
	if (ts.isArrayLiteralExpression(init)) return ': [...]'
	if (ts.isNewExpression(init) && init.expression) return `: ${init.expression.getText(sf)}`
	if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
		const p = params(sf, init)
		const r = retType(sf, init)
		return `: (${p})${r ? ` => ${r.slice(2)}` : ''}`
	}
	if (ts.isObjectLiteralExpression(init)) {
		const keys = init.properties
			.map(p => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? p.name?.getText(sf) : null)
			.filter(Boolean)
		return keys.length > 0 ? `: { ${keys.join(', ')} }` : ': {}'
	}
	if (ts.isAsExpression(init)) return inferType(sf, init.expression)
	return ''
}

async function walkTree(basePath: string, prefix: string, lines: string[]): Promise<void> {
	const entries = (await readdir(basePath, { withFileTypes: true }))
		.filter(e => !IGNORE.has(e.name))
		.sort((a, b) => a.name.localeCompare(b.name))

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		const isLast = i === entries.length - 1
		const connector = isLast ? '└── ' : '├── '
		const childPrefix = isLast ? '    ' : '│   '

		if (entry.isDirectory()) {
			lines.push(`${prefix}${connector}${entry.name}/`)
			await walkTree(join(basePath, entry.name), `${prefix}${childPrefix}`, lines)
		} else {
			lines.push(`${prefix}${connector}${entry.name}`)
		}
	}
}

async function walk(basePath: string, prefix: string, files: string[]): Promise<void> {
	const entries = await readdir(basePath, { withFileTypes: true })

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (IGNORE.has(entry.name)) continue
		const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

		if (entry.isDirectory()) {
			files.push(`${relPath}/`)
			await walk(join(basePath, entry.name), relPath, files)
		} else {
			files.push(relPath)
		}
	}
}

export async function readFile(rootPath: string, filePath: string): Promise<string> {
	return fsReadFile(join(rootPath, filePath), 'utf-8')
}

export async function grepSearch(rootPath: string, pattern: string, options?: { isRegexp?: boolean; includePattern?: string }): Promise<string> {
	const allFiles: string[] = []
	await walk(rootPath, '', allFiles)

	const regex = options?.isRegexp ? new RegExp(pattern, 'gi') : null
	const lowerPattern = pattern.toLowerCase()
	const includeGlob = options?.includePattern

	const matches: string[] = []
	const maxResults = 100

	for (const relPath of allFiles) {
		if (relPath.endsWith('/')) continue
		if (includeGlob && !minimatch(relPath, includeGlob)) continue

		try {
			const content = await fsReadFile(join(rootPath, relPath), 'utf-8')
			const lines = content.split('\n')
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]
				const isMatch = regex ? regex.test(line) : line.toLowerCase().includes(lowerPattern)
				if (regex) regex.lastIndex = 0
				if (isMatch) {
					matches.push(`${relPath}:${i + 1}: ${line.trimStart()}`)
					if (matches.length >= maxResults) {
						matches.push(`(truncated at ${maxResults} results)`)
						return matches.join('\n')
					}
				}
			}
		} catch { /* skip binary/unreadable */ }
	}

	return matches.length > 0 ? matches.join('\n') : 'No matches found.'
}

export async function fileSearch(rootPath: string, globPattern: string): Promise<string> {
	const allFiles: string[] = []
	await walk(rootPath, '', allFiles)

	const matches = allFiles.filter(f => minimatch(f, globPattern))
	if (matches.length === 0) return 'No files matched.'
	return matches.join('\n')
}

export async function listDirectory(rootPath: string, dirPath: string): Promise<string> {
	const fullPath = join(rootPath, dirPath)
	const entries = (await readdir(fullPath, { withFileTypes: true }))
		.filter(e => !IGNORE.has(e.name))
		.sort((a, b) => a.name.localeCompare(b.name))

	return entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).join('\n')
}

// Captures a baseline snapshot of the codebase structure at the start of each iteration.
// The builder can later call diffContext to see what structural changes its edits caused
// (new files, removed declarations, changed dependencies) without reading a full git diff.
let snapshot: { tree: string; declarations: string } | null = null

export async function snapshotCodebase(rootPath: string): Promise<void> {
	const [tree, declarations] = await Promise.all([
		getFileTree(rootPath),
		getDeclarationIndex(rootPath),
	])
	snapshot = { tree, declarations }
}

function diffSection(label: string, oldText: string, newText: string): string | null {
	const oldLines = oldText.split('\n')
	const newLines = newText.split('\n')
	const oldSet = new Set(oldLines)
	const newSet = new Set(newLines)

	const added = newLines.filter(l => !oldSet.has(l) && l.trim())
	const removed = oldLines.filter(l => !newSet.has(l) && l.trim())

	if (added.length === 0 && removed.length === 0) return null

	const parts: string[] = [`## ${label}`]
	if (removed.length > 0) parts.push(removed.map(l => `- ${l}`).join('\n'))
	if (added.length > 0) parts.push(added.map(l => `+ ${l}`).join('\n'))
	return parts.join('\n')
}

export async function diffContext(rootPath: string): Promise<string> {
	if (!snapshot) return 'No previous snapshot to compare against.'

	const [tree, declarations] = await Promise.all([
		getFileTree(rootPath),
		getDeclarationIndex(rootPath),
	])

	const sections = [
		diffSection('File Tree', snapshot.tree, tree),
		diffSection('Declarations', snapshot.declarations, declarations),
	].filter(Boolean)

	if (sections.length === 0) return 'No structural changes detected.'
	return sections.join('\n\n')
}

// Simplified glob matcher to avoid pulling in a minimatch dependency.
// Handles the basic patterns the agent uses: **, *, ?, and dot escaping.
function minimatch(filePath: string, pattern: string): boolean {
	const regexStr = pattern
		.replace(/\./g, '\\.')
		.replace(/\*\*/g, '<<<GLOBSTAR>>>')
		.replace(/\*/g, '[^/]*')
		.replace(/<<<GLOBSTAR>>>/g, '.*')
		.replace(/\?/g, '.')
	return new RegExp(`^${regexStr}$`).test(filePath)
}
