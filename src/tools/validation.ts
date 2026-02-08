import { execFile } from 'child_process'
import { promisify } from 'util'
import logger from '../logger.js'

const execFileAsync = promisify(execFile)

export interface ValidationResult {
	passed: boolean
	error?: string
}

async function runCommand(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync(cmd, args, { cwd, timeout: 120_000 })
}

export async function typeCheck(workspacePath: string): Promise<ValidationResult> {
	try {
		await runCommand('npx', ['tsc', '--noEmit'], workspacePath)
		logger.info('Type check passed')
		return { passed: true }
	} catch (err: unknown) {
		const message = err instanceof Error ? (err as Error & { stdout?: string; stderr?: string }).stdout || (err as Error & { stdout?: string; stderr?: string }).stderr || err.message : String(err)
		logger.warn(`Type check failed: ${message.slice(0, 300)}`)
		return { passed: false, error: `TypeScript type check failed:\n${message}` }
	}
}

export async function build(workspacePath: string): Promise<ValidationResult> {
	try {
		await runCommand('npx', ['tsc'], workspacePath)
		logger.info('Build passed')
		return { passed: true }
	} catch (err: unknown) {
		const message = err instanceof Error ? (err as Error & { stdout?: string; stderr?: string }).stdout || (err as Error & { stdout?: string; stderr?: string }).stderr || err.message : String(err)
		logger.warn(`Build failed: ${message.slice(0, 300)}`)
		return { passed: false, error: `TypeScript build failed:\n${message}` }
	}
}

export async function runTests(workspacePath: string): Promise<ValidationResult> {
	try {
		await runCommand('node', ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--passWithNoTests'], workspacePath)
		logger.info('Tests passed')
		return { passed: true }
	} catch (err: unknown) {
		const message = err instanceof Error ? (err as Error & { stdout?: string; stderr?: string }).stdout || (err as Error & { stdout?: string; stderr?: string }).stderr || err.message : String(err)
		logger.warn(`Tests failed: ${message.slice(0, 300)}`)
		return { passed: false, error: `Jest tests failed:\n${message}` }
	}
}

export async function validate(workspacePath: string): Promise<ValidationResult> {
	logger.info('Running local validation (type check, build, tests)...')

	const typeResult = await typeCheck(workspacePath)
	if (!typeResult.passed) return typeResult

	const buildResult = await build(workspacePath)
	if (!buildResult.passed) return buildResult

	const testResult = await runTests(workspacePath)
	if (!testResult.passed) return testResult

	logger.info('Local validation passed')
	return { passed: true }
}
