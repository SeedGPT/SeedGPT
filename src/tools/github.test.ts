import { jest, describe, it, expect, beforeEach } from '@jest/globals'

jest.unstable_mockModule('../config.js', () => ({
	config: {
		ci: { pollInterval: 10, timeout: 100, noChecksTimeout: 20 },
		errors: { maxCheckOutputChars: 2000 },
		batch: { pollInterval: 10, maxPollInterval: 50, pollBackoff: 1.5 },
	},
}))

jest.unstable_mockModule('../env.js', () => ({
	env: {
		githubToken: 'fake-token',
		githubOwner: 'test-owner',
		githubRepo: 'test-repo',
		workspacePath: '/test/workspace',
	},
}))

jest.unstable_mockModule('../logger.js', () => ({
	default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockGetHeadSha = jest.fn<(...a: unknown[]) => Promise<string>>().mockResolvedValue('abc123')
jest.unstable_mockModule('./git.js', () => ({
	getHeadSha: mockGetHeadSha,
}))

const mockExtractFailedStepOutput = jest.fn<(...a: unknown[]) => string>().mockReturnValue('Extracted error')
const mockExtractCoverageFromLogs = jest.fn<(...a: unknown[]) => string | null>().mockReturnValue(null)
jest.unstable_mockModule('./log-parsing.js', () => ({
	extractFailedStepOutput: mockExtractFailedStepOutput,
	extractCoverageFromLogs: mockExtractCoverageFromLogs,
}))

const mockPullsCreate = jest.fn<(...a: unknown[]) => Promise<{ data: { number: number } }>>()
	.mockResolvedValue({ data: { number: 42 } })
const mockPullsMerge = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const mockPullsUpdate = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const mockPullsList = jest.fn<(...a: unknown[]) => Promise<{ data: Array<{ head: { ref: string; sha: string }; number: number }> }>>()
const mockChecksListForRef = jest.fn<(...a: unknown[]) => Promise<{ data: { check_runs: Array<unknown> } }>>()
const mockDeleteRef = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
const mockListWorkflowRuns = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({ data: { workflow_runs: [] } })
const mockListJobsForWorkflowRun = jest.fn<(...a: unknown[]) => Promise<unknown>>()
const mockDownloadJobLogs = jest.fn<(...a: unknown[]) => Promise<unknown>>()

jest.unstable_mockModule('@octokit/rest', () => ({
	Octokit: class {
		pulls = { create: mockPullsCreate, merge: mockPullsMerge, update: mockPullsUpdate, list: mockPullsList }
		checks = { listForRef: mockChecksListForRef }
		git = { deleteRef: mockDeleteRef }
		actions = {
			listWorkflowRunsForRepo: mockListWorkflowRuns,
			listJobsForWorkflowRun: mockListJobsForWorkflowRun,
			downloadJobLogsForWorkflowRun: mockDownloadJobLogs,
		}
	},
}))

const github = await import('./github.js')

beforeEach(() => {
	jest.clearAllMocks()
})

describe('openPR', () => {
	it('creates a pull request and returns its number', async () => {
		const prNumber = await github.openPR('seedgpt/test-branch', 'Test PR', 'PR body')
		expect(prNumber).toBe(42)
		expect(mockPullsCreate).toHaveBeenCalledWith(expect.objectContaining({
			owner: 'test-owner',
			repo: 'test-repo',
			head: 'seedgpt/test-branch',
			base: 'main',
		}))
	})
})

describe('mergePR', () => {
	it('squash-merges the PR', async () => {
		await github.mergePR(42)
		expect(mockPullsMerge).toHaveBeenCalledWith(expect.objectContaining({
			pull_number: 42,
			merge_method: 'squash',
		}))
	})
})

describe('closePR', () => {
	it('closes the PR', async () => {
		await github.closePR(42)
		expect(mockPullsUpdate).toHaveBeenCalledWith(expect.objectContaining({
			pull_number: 42,
			state: 'closed',
		}))
	})
})

describe('deleteRemoteBranch', () => {
	it('deletes the ref', async () => {
		await github.deleteRemoteBranch('seedgpt/test')
		expect(mockDeleteRef).toHaveBeenCalledWith(expect.objectContaining({
			ref: 'heads/seedgpt/test',
		}))
	})
})

describe('awaitChecks', () => {
	beforeEach(() => {
		mockGetHeadSha.mockResolvedValue('sha123')
	})

	it('returns passed when all checks succeed', async () => {
		mockChecksListForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ status: 'completed', conclusion: 'success', name: 'build', id: 1, output: { title: null, summary: null, text: null } },
				],
			},
		})

		const result = await github.awaitChecks()
		expect(result.passed).toBe(true)
	})

	it('returns passed when no checks appear after timeout', async () => {
		mockChecksListForRef.mockResolvedValue({ data: { check_runs: [] } })

		const result = await github.awaitChecks()
		expect(result.passed).toBe(true)
	})

	it('returns failed with error when checks fail and workflow logs available', async () => {
		mockChecksListForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ status: 'completed', conclusion: 'failure', name: 'CI', id: 1, output: { title: 'fail', summary: 'Tests failed', text: null } },
				],
			},
		})

		mockListWorkflowRuns.mockResolvedValue({
			data: {
				workflow_runs: [
					{ id: 100, conclusion: 'failure' },
				],
			},
		})

		mockListJobsForWorkflowRun.mockResolvedValue({
			data: {
				jobs: [
					{
						id: 200, name: 'test', conclusion: 'failure',
						steps: [{ name: 'Run tests', conclusion: 'failure' }],
					},
				],
			},
		})

		mockDownloadJobLogs.mockResolvedValue({ data: 'log text here' })

		const result = await github.awaitChecks()
		expect(result.passed).toBe(false)
		expect(result.error).toBe('Extracted error')
		expect(mockExtractFailedStepOutput).toHaveBeenCalledWith('log text here', ['Run tests'])
	})

	it('treats non-success conclusions like cancelled as failures', async () => {
		mockChecksListForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ status: 'completed', conclusion: 'cancelled', name: 'CI', id: 1, output: { title: null, summary: 'Cancelled', text: null } },
				],
			},
		})

		mockListWorkflowRuns.mockRejectedValue(new Error('API error'))

		const result = await github.awaitChecks()
		expect(result.passed).toBe(false)
		expect(result.error).toContain('Check "CI" failed')
	})

	it('falls back to check run output when workflow API fails', async () => {
		mockChecksListForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ status: 'completed', conclusion: 'failure', name: 'Build', id: 1, output: { title: 'Build Error', summary: 'Compilation failed', text: 'error TS2345' } },
				],
			},
		})

		mockListWorkflowRuns.mockRejectedValue(new Error('API error'))

		const result = await github.awaitChecks()
		expect(result.passed).toBe(false)
		expect(result.error).toContain('Check "Build" failed')
		expect(result.error).toContain('Compilation failed')
		expect(result.error).toContain('error TS2345')
	})

	it('handles job logs unavailable gracefully', async () => {
		mockChecksListForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ status: 'completed', conclusion: 'failure', name: 'CI', id: 1, output: { title: null, summary: null, text: null } },
				],
			},
		})

		mockListWorkflowRuns.mockResolvedValue({
			data: {
				workflow_runs: [{ id: 100, conclusion: 'failure' }],
			},
		})

		mockListJobsForWorkflowRun.mockResolvedValue({
			data: {
				jobs: [{
					id: 200, name: 'test-job', conclusion: 'failure',
					steps: [{ name: 'npm test', conclusion: 'failure' }],
				}],
			},
		})

		mockDownloadJobLogs.mockRejectedValue(new Error('not available'))

		const result = await github.awaitChecks()
		expect(result.passed).toBe(false)
		expect(result.error).toContain('test-job')
		expect(result.error).toContain('logs unavailable')
	})

	it('waits when checks are still running then returns result', async () => {
		mockChecksListForRef
			.mockResolvedValueOnce({
				data: {
					check_runs: [
						{ status: 'in_progress', conclusion: null, name: 'CI', id: 1, output: { title: null, summary: null, text: null } },
					],
				},
			})
			.mockResolvedValueOnce({
				data: {
					check_runs: [
						{ status: 'completed', conclusion: 'success', name: 'CI', id: 1, output: { title: null, summary: null, text: null } },
					],
				},
			})

		const result = await github.awaitChecks()
		expect(result.passed).toBe(true)
		expect(mockChecksListForRef).toHaveBeenCalledTimes(2)
	})

	it('returns timeout error when checks never complete', async () => {
		mockChecksListForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ status: 'in_progress', conclusion: null, name: 'CI', id: 1, output: { title: null, summary: null, text: null } },
				],
			},
		})

		const result = await github.awaitChecks()
		expect(result.passed).toBe(false)
		expect(result.error).toContain('Timed out')
	})
})

describe('cleanupStalePRs', () => {
	it('closes and deletes branches for open agent PRs', async () => {
		mockPullsList.mockResolvedValue({
			data: [
				{ number: 10, head: { ref: 'seedgpt/old-branch', sha: 'sha1' } },
			],
		})

		await github.cleanupStalePRs()
		expect(mockPullsUpdate).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 10, state: 'closed' }))
		expect(mockDeleteRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/seedgpt/old-branch' }))
	})
})

describe('getLatestMainCoverage', () => {
	it('returns coverage from the latest successful main workflow run', async () => {
		mockListWorkflowRuns.mockResolvedValue({
			data: {
				workflow_runs: [{ id: 300, conclusion: 'success' }],
			},
		})

		mockListJobsForWorkflowRun.mockResolvedValue({
			data: {
				jobs: [{ id: 400 }],
			},
		})

		mockDownloadJobLogs.mockResolvedValue({ data: 'coverage log text' })
		mockExtractCoverageFromLogs.mockReturnValue('85%')

		const result = await github.getLatestMainCoverage()
		expect(result).toBe('85%')
		expect(mockExtractCoverageFromLogs).toHaveBeenCalledWith('coverage log text')
	})

	it('returns null when no successful workflow runs exist', async () => {
		mockListWorkflowRuns.mockResolvedValue({
			data: {
				workflow_runs: [{ id: 300, conclusion: 'failure' }],
			},
		})

		const result = await github.getLatestMainCoverage()
		expect(result).toBeNull()
	})

	it('returns null when workflow API throws', async () => {
		mockListWorkflowRuns.mockRejectedValue(new Error('API unavailable'))

		const result = await github.getLatestMainCoverage()
		expect(result).toBeNull()
	})

	it('skips jobs with unavailable logs and continues', async () => {
		mockListWorkflowRuns.mockResolvedValue({
			data: {
				workflow_runs: [{ id: 300, conclusion: 'success' }],
			},
		})

		mockListJobsForWorkflowRun.mockResolvedValue({
			data: {
				jobs: [{ id: 401 }, { id: 402 }],
			},
		})

		mockDownloadJobLogs
			.mockRejectedValueOnce(new Error('unavailable'))
			.mockResolvedValueOnce({ data: 'some log' })

		mockExtractCoverageFromLogs.mockReturnValue('90%')

		const result = await github.getLatestMainCoverage()
		expect(result).toBe('90%')
	})

	it('returns null when no job contains coverage', async () => {
		mockListWorkflowRuns.mockResolvedValue({
			data: {
				workflow_runs: [{ id: 300, conclusion: 'success' }],
			},
		})

		mockListJobsForWorkflowRun.mockResolvedValue({
			data: {
				jobs: [{ id: 400 }],
			},
		})

		mockDownloadJobLogs.mockResolvedValue({ data: 'no cov here' })
		mockExtractCoverageFromLogs.mockReturnValue(null)

		const result = await github.getLatestMainCoverage()
		expect(result).toBeNull()
	})
})
