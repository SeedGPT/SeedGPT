import { describe, it, expect } from '@jest/globals'
import { extractFailedStepOutput, extractCoverageFromLogs } from './log-parsing.js'

describe('extractFailedStepOutput', () => {
	it('extracts output from a single failed step with GitHub Actions markers', () => {
		const log = `##[group]Run tests
npm test
##[error]Tests failed with exit code 1
Process completed with exit code 1.
##[endgroup]
##[group]Build
npm run build
Build succeeded
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('Step "Run tests"')
		expect(result).toContain('ERROR: Tests failed with exit code 1')
		expect(result).not.toContain('Build succeeded')
	})

	it('extracts output from multiple failed steps', () => {
		const log = `##[group]Run lint
eslint .
##[error]Linting errors found
##[endgroup]
##[group]Run tests
npm test
##[error]Tests failed
##[endgroup]
##[group]Build
npm run build
Build succeeded
##[endgroup]`
		const result = extractFailedStepOutput(log, ['lint', 'tests'])
		expect(result).toContain('Step "Run lint"')
		expect(result).toContain('ERROR: Linting errors found')
		expect(result).toContain('Step "Run tests"')
		expect(result).toContain('ERROR: Tests failed')
		expect(result).not.toContain('Build succeeded')
	})

	it('extracts steps with ##[error] markers when no step names provided', () => {
		const log = `##[group]Run tests
npm test
##[error]Test suite failed to run
##[error]Cannot find module './missing.js'
##[endgroup]
##[group]Build
npm run build
Build succeeded
##[endgroup]`
		const result = extractFailedStepOutput(log, [])
		expect(result).toContain('Step "Run tests"')
		expect(result).toContain('ERROR: Test suite failed to run')
		expect(result).toContain('ERROR: Cannot find module')
		expect(result).not.toContain('Build succeeded')
	})

	it('prioritizes FAIL blocks over PASS blocks in Jest output', () => {
		const log = `##[group]Run tests
 PASS  src/agents/memory.test.ts
 PASS  src/agents/reflect.test.ts
 FAIL  src/agents/compression.test.ts
  ● compression › handles empty messages
    expect(received).toBe(expected)
    Expected: true
    Received: false
 PASS  src/logger.test.ts

Test Suites: 1 failed, 3 passed, 4 total
Tests:       1 failed, 15 passed, 16 total
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('FAIL  src/agents/compression.test.ts')
		expect(result).toContain('compression › handles empty messages')
		expect(result).toContain('Test Suites: 1 failed, 3 passed, 4 total')
		expect(result).not.toContain('PASS  src/agents/memory.test.ts')
		expect(result).not.toContain('PASS  src/logger.test.ts')
	})

	it('filters out noise lines from output', () => {
		const log = `##[group]Run tests
2024-01-15T10:30:00.123Z [INFO] Starting test suite
console.log
    at Object.<anonymous> (src/test.ts:10:11)
  ● Console
npm test
##[error]Tests failed
Test Suites: 1 failed, 1 total
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).not.toContain('[INFO]')
		expect(result).not.toContain('console.log')
		expect(result).not.toContain('at Object.<anonymous>')
		expect(result).not.toContain('● Console')
		expect(result).toContain('ERROR: Tests failed')
		expect(result).toContain('Test Suites: 1 failed, 1 total')
	})

	it('truncates output to 8000 characters', () => {
		const longLine = 'x'.repeat(9000)
		const log = `##[group]Run tests
${longLine}
##[error]Error at end
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result.length).toBeLessThanOrEqual(8000)
		expect(result).toContain('Error at end')
	})

	it('handles empty log without crashing', () => {
		const result = extractFailedStepOutput('', [])
		expect(result).toBe('')
	})

	it('extracts TypeScript errors from output', () => {
		const log = `##[group]Run tests
src/agents/plan.ts:42:15 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
42     const x = doSomething("hello")
                 ~~~~~~~~~~
src/agents/build.ts:100:5 - error TS2322: Type 'null' is not assignable to type 'string'.
100     let name: string = null
        ~~~~
Found 2 errors.
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('error TS2345')
		expect(result).toContain('error TS2322')
		expect(result).toContain('Found 2 errors')
	})

	it('extracts JavaScript runtime errors', () => {
		const log = `##[group]Run tests
TypeError: Cannot read property 'name' of undefined
    at process (src/app.ts:10:5)
ReferenceError: foo is not defined
    at main (src/index.ts:5:3)
SyntaxError: Unexpected token }
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('TypeError: Cannot read property')
		expect(result).toContain('ReferenceError: foo is not defined')
		expect(result).toContain('SyntaxError: Unexpected token')
	})

	it('extracts module not found errors', () => {
		const log = `##[group]Run tests
Error: Cannot find module './missing.js'
Module not found: Can't resolve './config'
ENOENT: no such file or directory, open '/path/to/file'
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('Cannot find module')
		expect(result).toContain('Module not found')
		expect(result).toContain('ENOENT')
	})

	it('matches step names case-insensitively', () => {
		const log = `##[group]Run Tests
npm test
##[error]Tests failed
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('Step "Run Tests"')
		expect(result).toContain('ERROR: Tests failed')
	})

	it('handles logs without step markers', () => {
		const log = `npm test
 FAIL  src/test.ts
  ● test › should work
    Expected: 1
    Received: 2
Test Suites: 1 failed, 1 total`
		const result = extractFailedStepOutput(log, [])
		expect(result).toContain('FAIL  src/test.ts')
		expect(result).toContain('Expected: 1')
		expect(result).toContain('Test Suites: 1 failed, 1 total')
	})

	it('strips timestamps and ANSI color codes', () => {
		const log = `##[group]Run tests
2024-01-15T10:30:00.123Z npm test
\x1b[31m\x1b[1mFAIL\x1b[22m\x1b[39m src/test.ts
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).not.toContain('2024-01-15T10:30:00.123Z')
		expect(result).not.toContain('\x1b[')
		expect(result).toContain('FAIL')
	})

	it('includes ERROR: prefix for generic errors', () => {
		const log = `##[group]Run tests
npm test
ERROR: Something went wrong
Process failed
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('ERROR: Something went wrong')
	})

	it('preserves summary lines in output', () => {
		const log = `##[group]Run tests
 FAIL  src/test.ts
Test Suites: 1 failed, 1 total
Tests:       5 failed, 10 passed, 15 total
Snapshots:   0 total
Time:        2.5 s
Ran all test suites.
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('Test Suites: 1 failed, 1 total')
		expect(result).toContain('Tests:       5 failed, 10 passed, 15 total')
		expect(result).toContain('Snapshots:   0 total')
		expect(result).toContain('Time:        2.5 s')
		expect(result).toContain('Ran all test suites.')
	})

	it('handles multiple FAIL blocks and extracts all', () => {
		const log = `##[group]Run tests
 FAIL  src/a.test.ts
  ● test a
    Error in a
 FAIL  src/b.test.ts
  ● test b
    Error in b
Test Suites: 2 failed, 2 total
##[endgroup]`
		const result = extractFailedStepOutput(log, ['tests'])
		expect(result).toContain('FAIL  src/a.test.ts')
		expect(result).toContain('Error in a')
		expect(result).toContain('FAIL  src/b.test.ts')
		expect(result).toContain('Error in b')
	})
})

describe('extractCoverageFromLogs', () => {
	it('extracts and formats coverage data from Coverage section', () => {
		const coverageJson = JSON.stringify({
			total: {
				statements: { total: 100, covered: 85, skipped: 0, pct: 85 },
				branches: { total: 50, covered: 40, skipped: 0, pct: 80 },
				functions: { total: 20, covered: 18, skipped: 0, pct: 90 },
				lines: { total: 100, covered: 85, skipped: 0, pct: 85 },
			},
			'src/app.ts': {
				statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
				branches: { total: 5, covered: 5, skipped: 0, pct: 100 },
				functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
				lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
			},
		})
		const log = `##[group]Coverage
Running coverage...
${coverageJson}
Coverage complete
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).not.toBeNull()
		expect(result).toContain('Coverage: 85% statements, 80% branches, 90% functions, 85% lines')
	})

	it('lists files with coverage below 50%', () => {
		const coverageJson = JSON.stringify({
			total: {
				statements: { total: 100, covered: 70, skipped: 0, pct: 70 },
				branches: { total: 50, covered: 35, skipped: 0, pct: 70 },
				functions: { total: 20, covered: 14, skipped: 0, pct: 70 },
				lines: { total: 100, covered: 70, skipped: 0, pct: 70 },
			},
			'src/a.ts': {
				statements: { total: 10, covered: 3, skipped: 0, pct: 30 },
				branches: { total: 5, covered: 1, skipped: 0, pct: 20 },
				functions: { total: 2, covered: 0, skipped: 0, pct: 0 },
				lines: { total: 10, covered: 3, skipped: 0, pct: 30 },
			},
			'src/b.ts': {
				statements: { total: 10, covered: 4, skipped: 0, pct: 40 },
				branches: { total: 5, covered: 2, skipped: 0, pct: 40 },
				functions: { total: 2, covered: 1, skipped: 0, pct: 50 },
				lines: { total: 10, covered: 4, skipped: 0, pct: 40 },
			},
			'src/c.ts': {
				statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
				branches: { total: 5, covered: 5, skipped: 0, pct: 100 },
				functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
				lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
			},
		})
		const log = `##[group]Coverage
${coverageJson}
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).toContain('Low coverage (<50%):')
		expect(result).toContain('src/a.ts (30%)')
		expect(result).toContain('src/b.ts (40%)')
		expect(result).not.toContain('src/c.ts')
	})

	it('counts files with 0% coverage as untested', () => {
		const coverageJson = JSON.stringify({
			total: {
				statements: { total: 100, covered: 50, skipped: 0, pct: 50 },
				branches: { total: 50, covered: 25, skipped: 0, pct: 50 },
				functions: { total: 20, covered: 10, skipped: 0, pct: 50 },
				lines: { total: 100, covered: 50, skipped: 0, pct: 50 },
			},
			'src/a.ts': {
				statements: { total: 10, covered: 0, skipped: 0, pct: 0 },
				branches: { total: 5, covered: 0, skipped: 0, pct: 0 },
				functions: { total: 2, covered: 0, skipped: 0, pct: 0 },
				lines: { total: 10, covered: 0, skipped: 0, pct: 0 },
			},
			'src/b.ts': {
				statements: { total: 10, covered: 0, skipped: 0, pct: 0 },
				branches: { total: 5, covered: 0, skipped: 0, pct: 0 },
				functions: { total: 2, covered: 0, skipped: 0, pct: 0 },
				lines: { total: 10, covered: 0, skipped: 0, pct: 0 },
			},
			'src/c.ts': {
				statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
				branches: { total: 5, covered: 5, skipped: 0, pct: 100 },
				functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
				lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
			},
		})
		const log = `##[group]Coverage
${coverageJson}
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).toContain('Untested files: 2')
		expect(result).toContain('src/a.ts (0%)')
		expect(result).toContain('src/b.ts (0%)')
	})

	it('returns null when no coverage section found', () => {
		const log = `##[group]Run tests
npm test
All tests passed
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).toBeNull()
	})

	it('returns null when coverage section has malformed JSON', () => {
		const log = `##[group]Coverage
Running coverage...
{ "total": { "statements": not valid json }
Coverage complete
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).toBeNull()
	})

	it('returns null when coverage section has no JSON', () => {
		const log = `##[group]Coverage
Running coverage...
No JSON output here
Coverage complete
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).toBeNull()
	})

	it('handles Run Coverage step name variant', () => {
		const coverageJson = JSON.stringify({
			total: {
				statements: { total: 100, covered: 90, skipped: 0, pct: 90 },
				branches: { total: 50, covered: 45, skipped: 0, pct: 90 },
				functions: { total: 20, covered: 18, skipped: 0, pct: 90 },
				lines: { total: 100, covered: 90, skipped: 0, pct: 90 },
			},
		})
		const log = `##[group]Run Coverage
npm run coverage
${coverageJson}
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).not.toBeNull()
		expect(result).toContain('Coverage: 90% statements, 90% branches, 90% functions, 90% lines')
	})

	it('handles step names containing Coverage', () => {
		const coverageJson = JSON.stringify({
			total: {
				statements: { total: 100, covered: 95, skipped: 0, pct: 95 },
				branches: { total: 50, covered: 47, skipped: 0, pct: 94 },
				functions: { total: 20, covered: 19, skipped: 0, pct: 95 },
				lines: { total: 100, covered: 95, skipped: 0, pct: 95 },
			},
		})
		const log = `##[group]Test Coverage Report
npm run test:coverage
${coverageJson}
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).not.toBeNull()
		expect(result).toContain('Coverage: 95% statements, 94% branches, 95% functions, 95% lines')
	})

	it('formats coverage with no low-coverage files', () => {
		const coverageJson = JSON.stringify({
			total: {
				statements: { total: 100, covered: 100, skipped: 0, pct: 100 },
				branches: { total: 50, covered: 50, skipped: 0, pct: 100 },
				functions: { total: 20, covered: 20, skipped: 0, pct: 100 },
				lines: { total: 100, covered: 100, skipped: 0, pct: 100 },
			},
			'src/app.ts': {
				statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
				branches: { total: 5, covered: 5, skipped: 0, pct: 100 },
				functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
				lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
			},
		})
		const log = `##[group]Coverage
${coverageJson}
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).toBe('Coverage: 100% statements, 100% branches, 100% functions, 100% lines')
		expect(result).not.toContain('Low coverage')
		expect(result).not.toContain('Untested files')
	})

	it('sorts low coverage files by coverage percentage ascending', () => {
		const coverageJson = JSON.stringify({
			total: {
				statements: { total: 100, covered: 60, skipped: 0, pct: 60 },
				branches: { total: 50, covered: 30, skipped: 0, pct: 60 },
				functions: { total: 20, covered: 12, skipped: 0, pct: 60 },
				lines: { total: 100, covered: 60, skipped: 0, pct: 60 },
			},
			'src/high.ts': {
				statements: { total: 10, covered: 4, skipped: 0, pct: 40 },
				branches: { total: 5, covered: 2, skipped: 0, pct: 40 },
				functions: { total: 2, covered: 1, skipped: 0, pct: 50 },
				lines: { total: 10, covered: 4, skipped: 0, pct: 40 },
			},
			'src/low.ts': {
				statements: { total: 10, covered: 1, skipped: 0, pct: 10 },
				branches: { total: 5, covered: 0, skipped: 0, pct: 0 },
				functions: { total: 2, covered: 0, skipped: 0, pct: 0 },
				lines: { total: 10, covered: 1, skipped: 0, pct: 10 },
			},
			'src/mid.ts': {
				statements: { total: 10, covered: 2, skipped: 0, pct: 20 },
				branches: { total: 5, covered: 1, skipped: 0, pct: 20 },
				functions: { total: 2, covered: 0, skipped: 0, pct: 0 },
				lines: { total: 10, covered: 2, skipped: 0, pct: 20 },
			},
		})
		const log = `##[group]Coverage
${coverageJson}
##[endgroup]`
		const result = extractCoverageFromLogs(log)
		expect(result).toContain('Low coverage (<50%):')
		const lowCoverageIndex = result.indexOf('Low coverage')
		const lowIndex = result.indexOf('src/low.ts (10%)', lowCoverageIndex)
		const midIndex = result.indexOf('src/mid.ts (20%)', lowCoverageIndex)
		const highIndex = result.indexOf('src/high.ts (40%)', lowCoverageIndex)
		expect(lowIndex).toBeLessThan(midIndex)
		expect(midIndex).toBeLessThan(highIndex)
	})
})
