import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

const mockOctokit = {
	pulls: {
		create: jest.fn<() => Promise<{ data: { number: number } }>>(),
		merge: jest.fn<() => Promise<void>>(),
		update: jest.fn<() => Promise<void>>(),
		list: jest.fn<() => Promise<{ data: Array<{ number: number, head: { ref: string, sha: string } }> }>>(),
	},
	checks: {
		listForRef: jest.fn<() => Promise<{ data: { check_runs: Array<{ id: number, status: string, conclusion: string | null, name: string, output: { title: string | null, summary: string | null, text: string | null } }> } }>>(),
		listAnnotations: jest.fn<() => Promise<{ data: Array<{ path: string, start_line: number, annotation_level: string, message: string }> }>>(),
	},
	actions: {
		listWorkflowRunsForRepo: jest.fn<() => Promise<{ data: { workflow_runs: Array<{ id: number, conclusion: string | null }> } }>>(),
		listJobsForWorkflowRun: jest.fn<() => Promise<{ data: { jobs: Array<{ id: number, name: string, conclusion: string | null, steps?: Array<{ name: string, conclusion: string | null }> }> } }>>(),
		downloadJobLogsForWorkflowRun: jest.fn<() => Promise<{ data: string }>>(),
	},
	git: {
		deleteRef: jest.fn<() => Promise<void>>(),
	},
}

jest.unstable_mockModule('../config.js', () => ({
	config: {
		githubToken: 'test-token',
		githubOwner: 'test-owner',
		githubRepo: 'test-repo',
	},
}))

jest.unstable_mockModule('@octokit/rest', () => ({
	Octokit: jest.fn().mockImplementation(() => mockOctokit),
}))

jest.unstable_mockModule('../logger.js', () => ({
	default: {
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	},
}))

const github = await import('./github.js')

beforeEach(() => {
	jest.clearAllMocks()
})

describe('openPR', () => {
	it('creates a PR and returns the PR number', async () => {
		mockOctokit.pulls.create.mockResolvedValue({ data: { number: 42 } })

		const result = await github.openPR('seedgpt/test-branch', 'Test PR', 'Description body')

		expect(result).toBe(42)
		expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			title: 'Test PR',
			body: 'Description body',
			head: 'seedgpt/test-branch',
			base: 'main',
		})
	})
})

describe('awaitPRChecks', () => {
	beforeEach(() => {
		jest.useFakeTimers()
	})

	afterEach(() => {
		jest.useRealTimers()
	})

	it('returns passed when all checks succeed', async () => {
		mockOctokit.checks.listForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ id: 1, status: 'completed', conclusion: 'success', name: 'build', output: { title: null, summary: null, text: null } },
				],
			},
		})

		const promise = github.awaitPRChecks('abc123')
		await jest.advanceTimersByTimeAsync(0)

		const result = await promise
		expect(result).toEqual({ passed: true })
	})

	it('waits and returns passed after checks complete on second poll', async () => {
		mockOctokit.checks.listForRef
			.mockResolvedValueOnce({
				data: {
					check_runs: [
						{ id: 1, status: 'in_progress', conclusion: null, name: 'build', output: { title: null, summary: null, text: null } },
					],
				},
			})
			.mockResolvedValue({
				data: {
					check_runs: [
						{ id: 1, status: 'completed', conclusion: 'success', name: 'build', output: { title: null, summary: null, text: null } },
					],
				},
			})

		const promise = github.awaitPRChecks('abc123')
		await jest.advanceTimersByTimeAsync(30_000)
		await jest.advanceTimersByTimeAsync(30_000)

		const result = await promise
		expect(result).toEqual({ passed: true })
	})

	it('returns failure with error details when checks fail', async () => {
		mockOctokit.checks.listForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ id: 1, status: 'completed', conclusion: 'failure', name: 'build', output: { title: 'Build failed', summary: 'Compile error', text: null } },
				],
			},
		})
		mockOctokit.checks.listAnnotations.mockResolvedValue({
			data: [
				{ path: 'src/index.ts', start_line: 5, annotation_level: 'failure', message: 'Type error' },
			],
		})
		mockOctokit.actions.listWorkflowRunsForRepo.mockResolvedValue({
			data: { workflow_runs: [] },
		})

		const promise = github.awaitPRChecks('abc123')
		await jest.advanceTimersByTimeAsync(0)

		const result = await promise
		expect(result.passed).toBe(false)
		expect(result.error).toContain('build')
		expect(result.error).toContain('failure')
		expect(result.error).toContain('Compile error')
		expect(result.error).toContain('src/index.ts:5')
		expect(result.error).toContain('Type error')
	})

	it('returns passed when no checks appear after 2 minutes', async () => {
		mockOctokit.checks.listForRef.mockResolvedValue({
			data: { check_runs: [] },
		})

		const promise = github.awaitPRChecks('abc123')

		// Advance past the NO_CHECKS_TIMEOUT (2 minutes)
		for (let i = 0; i < 5; i++) {
			await jest.advanceTimersByTimeAsync(30_000)
		}

		const result = await promise
		expect(result).toEqual({ passed: true })
	})

	it('times out after 20 minutes', async () => {
		mockOctokit.checks.listForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ id: 1, status: 'in_progress', conclusion: null, name: 'build', output: { title: null, summary: null, text: null } },
				],
			},
		})

		const promise = github.awaitPRChecks('abc123')

		// Advance past the full TIMEOUT (20 minutes)
		for (let i = 0; i < 42; i++) {
			await jest.advanceTimersByTimeAsync(30_000)
		}

		const result = await promise
		expect(result.passed).toBe(false)
		expect(result.error).toContain('Timed out')
	})

	it('includes workflow job logs in error details', async () => {
		mockOctokit.checks.listForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ id: 1, status: 'completed', conclusion: 'failure', name: 'CI', output: { title: null, summary: null, text: null } },
				],
			},
		})
		mockOctokit.checks.listAnnotations.mockResolvedValue({ data: [] })
		mockOctokit.actions.listWorkflowRunsForRepo.mockResolvedValue({
			data: {
				workflow_runs: [{ id: 100, conclusion: 'failure' }],
			},
		})
		mockOctokit.actions.listJobsForWorkflowRun.mockResolvedValue({
			data: {
				jobs: [{ id: 200, name: 'test-job', conclusion: 'failure', steps: [] }],
			},
		})
		mockOctokit.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
			data: 'Error: test failed at line 42',
		})

		const promise = github.awaitPRChecks('sha456')
		await jest.advanceTimersByTimeAsync(0)

		const result = await promise
		expect(result.passed).toBe(false)
		expect(result.error).toContain('test-job')
		expect(result.error).toContain('Error: test failed at line 42')
	})

	it('falls back to step names when log download fails', async () => {
		mockOctokit.checks.listForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ id: 1, status: 'completed', conclusion: 'failure', name: 'CI', output: { title: null, summary: null, text: null } },
				],
			},
		})
		mockOctokit.checks.listAnnotations.mockResolvedValue({ data: [] })
		mockOctokit.actions.listWorkflowRunsForRepo.mockResolvedValue({
			data: {
				workflow_runs: [{ id: 100, conclusion: 'failure' }],
			},
		})
		mockOctokit.actions.listJobsForWorkflowRun.mockResolvedValue({
			data: {
				jobs: [{
					id: 200,
					name: 'test-job',
					conclusion: 'failure',
					steps: [
						{ name: 'Run tests', conclusion: 'failure' },
						{ name: 'Lint', conclusion: 'success' },
					],
				}],
			},
		})
		mockOctokit.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(new Error('forbidden'))

		const promise = github.awaitPRChecks('sha789')
		await jest.advanceTimersByTimeAsync(0)

		const result = await promise
		expect(result.passed).toBe(false)
		expect(result.error).toContain('test-job')
		expect(result.error).toContain('Run tests')
	})
})

describe('mergePR', () => {
	it('squash merges the PR', async () => {
		mockOctokit.pulls.merge.mockResolvedValue(undefined as never)

		await github.mergePR(42)

		expect(mockOctokit.pulls.merge).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			pull_number: 42,
			merge_method: 'squash',
		})
	})
})

describe('closePR', () => {
	it('closes the PR by updating its state', async () => {
		mockOctokit.pulls.update.mockResolvedValue(undefined as never)

		await github.closePR(99)

		expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			pull_number: 99,
			state: 'closed',
		})
	})
})

describe('deleteRemoteBranch', () => {
	it('deletes the remote branch ref', async () => {
		mockOctokit.git.deleteRef.mockResolvedValue(undefined as never)

		await github.deleteRemoteBranch('seedgpt/my-feature')

		expect(mockOctokit.git.deleteRef).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			ref: 'heads/seedgpt/my-feature',
		})
	})
})

describe('findOpenAgentPRs', () => {
	it('returns only PRs with seedgpt/ prefix', async () => {
		mockOctokit.pulls.list.mockResolvedValue({
			data: [
				{ number: 1, head: { ref: 'seedgpt/feature-a', sha: 'aaa' } },
				{ number: 2, head: { ref: 'feature/unrelated', sha: 'bbb' } },
				{ number: 3, head: { ref: 'seedgpt/feature-b', sha: 'ccc' } },
			],
		})

		const result = await github.findOpenAgentPRs()

		expect(result).toEqual([
			{ number: 1, head: { ref: 'seedgpt/feature-a', sha: 'aaa' } },
			{ number: 3, head: { ref: 'seedgpt/feature-b', sha: 'ccc' } },
		])
	})

	it('returns empty array when no agent PRs are open', async () => {
		mockOctokit.pulls.list.mockResolvedValue({
			data: [
				{ number: 10, head: { ref: 'feature/other', sha: 'xxx' } },
			],
		})

		const result = await github.findOpenAgentPRs()
		expect(result).toEqual([])
	})

	it('returns empty array when no PRs are open', async () => {
		mockOctokit.pulls.list.mockResolvedValue({ data: [] })

		const result = await github.findOpenAgentPRs()
		expect(result).toEqual([])
	})

	it('passes correct parameters to list PRs', async () => {
		mockOctokit.pulls.list.mockResolvedValue({ data: [] })

		await github.findOpenAgentPRs()

		expect(mockOctokit.pulls.list).toHaveBeenCalledWith({
			owner: 'test-owner',
			repo: 'test-repo',
			state: 'open',
			base: 'main',
		})
	})
})
