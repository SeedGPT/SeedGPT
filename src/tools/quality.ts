import { readFile } from 'fs/promises'
import { join } from 'path'
import ts from 'typescript'
import { env } from '../env.js'

export interface QualityIssue {
	type: 'long-function' | 'high-complexity' | 'deep-nesting' | 'too-many-parameters'
	location: {
		file: string
		line: number
		functionName: string
	}
	severity: 'warning' | 'error'
	description: string
}

const THRESHOLDS = {
	maxFunctionLines: 50,
	maxComplexity: 10,
	maxNestingDepth: 4,
	maxParameters: 5,
}

export async function analyzeCodeQuality(filePath: string, workspacePath?: string): Promise<QualityIssue[]> {
	try {
		const basePath = workspacePath ?? env.workspacePath
		const fullPath = join(basePath, filePath)
		const content = await readFile(fullPath, 'utf-8')
		const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		
		const issues: QualityIssue[] = []
		visitNode(sourceFile, sourceFile, issues)
		return issues
	} catch (err) {
		// Gracefully handle parse errors or file not found
		return []
	}
}

function visitNode(sourceFile: ts.SourceFile, node: ts.Node, issues: QualityIssue[]): void {
	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		analyzeFunctionNode(sourceFile, node, issues)
	}
	
	ts.forEachChild(node, child => visitNode(sourceFile, child, issues))
}

function analyzeFunctionNode(
	sourceFile: ts.SourceFile,
	node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression,
	issues: QualityIssue[]
): void {
	const functionName = getFunctionName(node)
	const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
	const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
	const lineCount = endLine - startLine + 1
	
	// Check function length
	if (lineCount > THRESHOLDS.maxFunctionLines) {
		issues.push({
			type: 'long-function',
			location: {
				file: sourceFile.fileName,
				line: startLine,
				functionName,
			},
			severity: 'warning',
			description: `Function "${functionName}" is ${lineCount} lines long (max ${THRESHOLDS.maxFunctionLines})`,
		})
	}
	
	// Check parameter count
	const parameters = getParameters(node)
	if (parameters > THRESHOLDS.maxParameters) {
		issues.push({
			type: 'too-many-parameters',
			location: {
				file: sourceFile.fileName,
				line: startLine,
				functionName,
			},
			severity: 'warning',
			description: `Function "${functionName}" has ${parameters} parameters (max ${THRESHOLDS.maxParameters})`,
		})
	}
	
	// Check cyclomatic complexity
	const complexity = calculateComplexity(node)
	if (complexity > THRESHOLDS.maxComplexity) {
		issues.push({
			type: 'high-complexity',
			location: {
				file: sourceFile.fileName,
				line: startLine,
				functionName,
			},
			severity: 'error',
			description: `Function "${functionName}" has cyclomatic complexity of ${complexity} (max ${THRESHOLDS.maxComplexity})`,
		})
	}
	
	// Check nesting depth
	const maxDepth = calculateMaxNestingDepth(node)
	if (maxDepth > THRESHOLDS.maxNestingDepth) {
		issues.push({
			type: 'deep-nesting',
			location: {
				file: sourceFile.fileName,
				line: startLine,
				functionName,
			},
			severity: 'warning',
			description: `Function "${functionName}" has nesting depth of ${maxDepth} (max ${THRESHOLDS.maxNestingDepth})`,
		})
	}
}

function getFunctionName(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression): string {
	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
		return node.name?.getText() ?? '<anonymous>'
	}
	if (ts.isFunctionExpression(node)) {
		return node.name?.getText() ?? '<anonymous>'
	}
	return '<arrow>'
}

function getParameters(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression): number {
	return node.parameters.length
}

function calculateComplexity(node: ts.Node): number {
	let complexity = 1 // Base complexity
	
	function visit(n: ts.Node): void {
		// if, else if, while, for, do-while, case
		if (
			ts.isIfStatement(n) ||
			ts.isWhileStatement(n) ||
			ts.isForStatement(n) ||
			ts.isForInStatement(n) ||
			ts.isForOfStatement(n) ||
			ts.isDoStatement(n) ||
			ts.isCaseClause(n)
		) {
			complexity++
		}
		
		// catch clause
		if (ts.isCatchClause(n)) {
			complexity++
		}
		
		// Ternary operator
		if (ts.isConditionalExpression(n)) {
			complexity++
		}
		
		// Logical AND and OR
		if (ts.isBinaryExpression(n)) {
			if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || 
			    n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
				complexity++
			}
		}
		
		ts.forEachChild(n, visit)
	}
	
	visit(node)
	return complexity
}

function calculateMaxNestingDepth(node: ts.Node): number {
	let maxDepth = 0
	
	function visit(n: ts.Node, currentDepth: number): void {
		let depth = currentDepth
		
		// Increase depth for nesting constructs
		if (
			ts.isIfStatement(n) ||
			ts.isWhileStatement(n) ||
			ts.isForStatement(n) ||
			ts.isForInStatement(n) ||
			ts.isForOfStatement(n) ||
			ts.isDoStatement(n) ||
			ts.isSwitchStatement(n) ||
			ts.isTryStatement(n) ||
			ts.isCatchClause(n) ||
			ts.isBlock(n)
		) {
			depth++
			maxDepth = Math.max(maxDepth, depth)
		}
		
		ts.forEachChild(n, child => visit(child, depth))
	}
	
	visit(node, 0)
	return maxDepth
}
