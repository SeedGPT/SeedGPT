import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { analyzeCodeQuality } from './quality.js'
import { env } from '../env.js'

describe('analyzeCodeQuality', () => {
	let tempDir: string
	let originalWorkspacePath: string

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'seedgpt-quality-'))
		originalWorkspacePath = env.workspacePath
		// @ts-expect-error - mutating env for test
		env.workspacePath = tempDir
	})

	afterEach(async () => {
		// @ts-expect-error - restoring env after test
		env.workspacePath = originalWorkspacePath
		await rm(tempDir, { recursive: true, force: true })
	})

	it('returns empty array for clean code', async () => {
		const code = `export function greet(name: string): string {
	return 'Hello, ' + name
}

export function add(a: number, b: number): number {
	return a + b
}
`
		await writeFile(join(tempDir, 'clean.ts'), code)
		const issues = await analyzeCodeQuality('clean.ts')
		expect(issues).toEqual([])
	})

	it('detects long functions', async () => {
		const lines = ['export function longFunction() {']
		for (let i = 0; i < 60; i++) {
			lines.push(`\tconsole.log(${i})`)
		}
		lines.push('}')
		const code = lines.join('\n')
		
		await writeFile(join(tempDir, 'long.ts'), code)
		const issues = await analyzeCodeQuality('long.ts')
		
		const longFunctionIssue = issues.find(i => i.type === 'long-function')
		expect(longFunctionIssue).toBeDefined()
		expect(longFunctionIssue?.severity).toBe('warning')
		expect(longFunctionIssue?.location.functionName).toBe('longFunction')
		expect(longFunctionIssue?.description).toContain('62 lines long')
	})

	it('detects high cyclomatic complexity', async () => {
		const code = `export function complexFunction(a: number, b: number, c: number): number {
	if (a > 0) {
		if (b > 0) {
			if (c > 0) {
				return a + b + c
			} else {
				return a + b
			}
		} else if (c > 0) {
			return a + c
		} else {
			return a
		}
	} else if (b > 0) {
		if (c > 0) {
			return b + c
		} else {
			return b
		}
	} else {
		return c
	}
}
`
		await writeFile(join(tempDir, 'complex.ts'), code)
		const issues = await analyzeCodeQuality('complex.ts')
		
		const complexityIssue = issues.find(i => i.type === 'high-complexity')
		expect(complexityIssue).toBeDefined()
		expect(complexityIssue?.severity).toBe('error')
		expect(complexityIssue?.location.functionName).toBe('complexFunction')
		expect(complexityIssue?.description).toContain('cyclomatic complexity')
	})

	it('detects deep nesting', async () => {
		const code = `export function deeplyNested(x: number): number {
	if (x > 0) {
		if (x > 10) {
			if (x > 20) {
				if (x > 30) {
					if (x > 40) {
						return x
					}
				}
			}
		}
	}
	return 0
}
`
		await writeFile(join(tempDir, 'nested.ts'), code)
		const issues = await analyzeCodeQuality('nested.ts')
		
		const nestingIssue = issues.find(i => i.type === 'deep-nesting')
		expect(nestingIssue).toBeDefined()
		expect(nestingIssue?.severity).toBe('warning')
		expect(nestingIssue?.location.functionName).toBe('deeplyNested')
		expect(nestingIssue?.description).toContain('nesting depth')
	})

	it('detects too many parameters', async () => {
		const code = `export function manyParams(
	a: string,
	b: number,
	c: boolean,
	d: string,
	e: number,
	f: boolean
): void {
	console.log(a, b, c, d, e, f)
}
`
		await writeFile(join(tempDir, 'params.ts'), code)
		const issues = await analyzeCodeQuality('params.ts')
		
		const paramsIssue = issues.find(i => i.type === 'too-many-parameters')
		expect(paramsIssue).toBeDefined()
		expect(paramsIssue?.severity).toBe('warning')
		expect(paramsIssue?.location.functionName).toBe('manyParams')
		expect(paramsIssue?.description).toContain('6 parameters')
	})

	it('detects complexity from logical operators', async () => {
		const code = `export function logicalComplexity(a: boolean, b: boolean, c: boolean): boolean {
	return (a && b) || (b && c) || (a && c) || (a || b) || (b || c) || (a || c)
}
`
		await writeFile(join(tempDir, 'logical.ts'), code)
		const issues = await analyzeCodeQuality('logical.ts')
		
		const complexityIssue = issues.find(i => i.type === 'high-complexity')
		expect(complexityIssue).toBeDefined()
	})

	it('detects complexity from loops', async () => {
		const code = `export function loopComplexity(items: number[]): number {
	let sum = 0
	for (const item of items) {
		if (item > 0) {
			while (item > 10) {
				for (let i = 0; i < item; i++) {
					if (i % 2 === 0) {
						do {
							sum++
						} while (sum < 100)
					}
				}
			}
		}
	}
	return sum
}
`
		await writeFile(join(tempDir, 'loops.ts'), code)
		const issues = await analyzeCodeQuality('loops.ts')
		
		const complexityIssue = issues.find(i => i.type === 'high-complexity')
		expect(complexityIssue).toBeDefined()
	})

	it('detects complexity from switch statements', async () => {
		const code = `export function switchComplexity(x: number): string {
	switch (x) {
		case 1:
			return 'one'
		case 2:
			return 'two'
		case 3:
			return 'three'
		case 4:
			return 'four'
		case 5:
			return 'five'
		case 6:
			return 'six'
		case 7:
			return 'seven'
		case 8:
			return 'eight'
		case 9:
			return 'nine'
		case 10:
			return 'ten'
		default:
			return 'other'
	}
}
`
		await writeFile(join(tempDir, 'switch.ts'), code)
		const issues = await analyzeCodeQuality('switch.ts')
		
		const complexityIssue = issues.find(i => i.type === 'high-complexity')
		expect(complexityIssue).toBeDefined()
	})

	it('detects complexity from ternary operators', async () => {
		const code = `export function ternaryComplexity(a: number, b: number, c: number): number {
	return a > b ? (b > c ? a : b) : (c > a ? (a > b ? a : b) : (b > c ? b : c))
}
`
		await writeFile(join(tempDir, 'ternary.ts'), code)
		const issues = await analyzeCodeQuality('ternary.ts')
		
		const complexityIssue = issues.find(i => i.type === 'high-complexity')
		expect(complexityIssue).toBeDefined()
	})

	it('detects complexity from catch clauses', async () => {
		const code = `export function catchComplexity(): void {
	try {
		try {
			try {
				try {
					try {
						throw new Error('test')
					} catch (e1) {
						throw e1
					}
				} catch (e2) {
					throw e2
				}
			} catch (e3) {
				throw e3
			}
		} catch (e4) {
			throw e4
		}
	} catch (e5) {
		console.error(e5)
	}
}
`
		await writeFile(join(tempDir, 'catch.ts'), code)
		const issues = await analyzeCodeQuality('catch.ts')
		
		const complexityIssue = issues.find(i => i.type === 'high-complexity')
		expect(complexityIssue).toBeDefined()
	})

	it('analyzes arrow functions', async () => {
		const code = `export const arrow = (a: number, b: number, c: number, d: number, e: number, f: number) => {
	return a + b + c + d + e + f
}
`
		await writeFile(join(tempDir, 'arrow.ts'), code)
		const issues = await analyzeCodeQuality('arrow.ts')
		
		const paramsIssue = issues.find(i => i.type === 'too-many-parameters')
		expect(paramsIssue).toBeDefined()
		expect(paramsIssue?.location.functionName).toBe('<arrow>')
	})

	it('analyzes class methods', async () => {
		const code = `export class MyClass {
	method(a: string, b: string, c: string, d: string, e: string, f: string): void {
		console.log(a, b, c, d, e, f)
	}
}
`
		await writeFile(join(tempDir, 'class.ts'), code)
		const issues = await analyzeCodeQuality('class.ts')
		
		const paramsIssue = issues.find(i => i.type === 'too-many-parameters')
		expect(paramsIssue).toBeDefined()
		expect(paramsIssue?.location.functionName).toBe('method')
	})

	it('reports multiple issues for the same function', async () => {
		const lines = ['export function problematic(a: string, b: string, c: string, d: string, e: string, f: string): void {']
		// Make it long
		for (let i = 0; i < 60; i++) {
			lines.push(`\tif (a === '${i}') {`)
			lines.push(`\t\tconsole.log(${i})`)
			lines.push(`\t}`)
		}
		lines.push('}')
		const code = lines.join('\n')
		
		await writeFile(join(tempDir, 'problematic.ts'), code)
		const issues = await analyzeCodeQuality('problematic.ts')
		
		// Should have multiple issues
		expect(issues.length).toBeGreaterThan(1)
		expect(issues.some(i => i.type === 'long-function')).toBe(true)
		expect(issues.some(i => i.type === 'too-many-parameters')).toBe(true)
		expect(issues.some(i => i.type === 'high-complexity')).toBe(true)
	})

	it('handles parse errors gracefully', async () => {
		const invalidCode = `export function broken( {
	this is not valid typescript
`
		await writeFile(join(tempDir, 'broken.ts'), invalidCode)
		const issues = await analyzeCodeQuality('broken.ts')
		
		// Should return empty array instead of throwing
		expect(issues).toEqual([])
	})

	it('handles non-existent files gracefully', async () => {
		const issues = await analyzeCodeQuality('does-not-exist.ts')
		expect(issues).toEqual([])
	})

	it('provides correct line numbers', async () => {
		const code = `// Comment line 1
// Comment line 2

export function problematic(a: string, b: string, c: string, d: string, e: string, f: string): void {
	console.log(a, b, c, d, e, f)
}
`
		await writeFile(join(tempDir, 'linenum.ts'), code)
		const issues = await analyzeCodeQuality('linenum.ts')
		
		const paramsIssue = issues.find(i => i.type === 'too-many-parameters')
		expect(paramsIssue?.location.line).toBe(4)
	})

	it('ignores anonymous functions in location', async () => {
		const code = `export const handler = function(a: string, b: string, c: string, d: string, e: string, f: string) {
	console.log(a, b, c, d, e, f)
}
`
		await writeFile(join(tempDir, 'anon.ts'), code)
		const issues = await analyzeCodeQuality('anon.ts')
		
		const paramsIssue = issues.find(i => i.type === 'too-many-parameters')
		expect(paramsIssue?.location.functionName).toBe('<anonymous>')
	})
})
