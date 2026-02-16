import { config } from '../config'

interface CoverageMetric {
	total: number
	covered: number
	skipped: number
	pct: number
}

interface FileCoverage {
	statements: CoverageMetric
	branches: CoverageMetric
	functions: CoverageMetric
	lines: CoverageMetric
}

interface CoverageSummaryJson {
	total: FileCoverage
	[filePath: string]: FileCoverage
}

function stripLogLine(line: string): string {
	return line
		.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
		.replace(/\x1b\[[0-9;]*m/g, '')
}

function isNoise(line: string): boolean {
	return /^\s*(console\.(log|warn|error))$/.test(line) ||
		/^\s+at\s+\S+\s+\(/.test(line) ||
		/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+\[(INFO|DEBUG)]/.test(line) ||
		/^\s*● Console$/.test(line)
}

function prioritizeFailures(lines: string[]): string {
	const failBlocks: string[] = []
	const summaryLines: string[] = []
	let inFail = false
	let inPass = false

	for (const line of lines) {
		if (/^\s*FAIL\s/.test(line)) {
			inFail = true
			inPass = false
			failBlocks.push(line)
		} else if (/^\s*PASS\s/.test(line)) {
			inFail = false
			inPass = true
		} else if (/^(Test Suites:|Tests:|Snapshots:|Time:|Ran all)/.test(line) || /^ERROR:/.test(line)) {
			inFail = false
			inPass = false
			summaryLines.push(line)
		} else if (inFail) {
			failBlocks.push(line)
		}
	}

	if (failBlocks.length > 0) {
		return [...failBlocks, '', ...summaryLines].join('\n').slice(-8000)
	}

	const errorLines = lines.filter(l =>
		/error\s*TS\d+/i.test(l) ||
		/SyntaxError|TypeError|ReferenceError|RangeError/.test(l) ||
		/Cannot find module|Module not found/.test(l) ||
		/ENOENT|EACCES/.test(l) ||
		(/^ERROR:/i.test(l) && !/Process completed with exit code/.test(l)),
	)

	if (errorLines.length > 0 || summaryLines.length > 0) {
		return [...errorLines, '', ...summaryLines].join('\n').slice(-8000)
	}

	const cleaned = lines.filter(l => l.trim() !== '' && !isNoise(l) && !/^\s*PASS\s/.test(l))
	return cleaned.join('\n').slice(-8000)
}

function parseStepSections(logText: string): { name: string; start: number; end: number; lines: string[] } [] {
	const raw = logText.split('\n')
	const lines = raw.map(stripLogLine)

	const sections: { name: string; start: number; end: number }[] = []
	let current: { name: string; start: number } | null = null

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^##\[group](.+)/)
		if (match) {
			if (current) sections.push({ ...current, end: i })
			current = { name: match[1], start: i }
		}
	}
	if (current) sections.push({ ...current, end: lines.length })

	return sections.map(s => ({ ...s, lines }))
}

export function extractFailedStepOutput(logText: string, failedStepNames: string[]): string {
	const parsed = parseStepSections(logText)
	const lines = parsed[0]?.lines ?? logText.split('\n').map(stripLogLine)
	const stepSections = parsed.map(({ name, start, end }) => ({ name, start, end }))

	const matchesStep = (sectionName: string, stepName: string): boolean => {
		const a = sectionName.toLowerCase()
		const b = stepName.toLowerCase()
		return a.includes(b) || a === `run ${b}`
	}

	const failedSections = failedStepNames.length > 0
		? stepSections.filter(s => failedStepNames.some(name => matchesStep(s.name, name)))
		: stepSections.filter(s => lines.slice(s.start, s.end).some(l => l.startsWith('##[error]')))

	if (failedSections.length > 0) {
		const output = failedSections.map(section => {
			const content = lines.slice(section.start, section.end)
				.filter(l => !l.startsWith('##[group]') && !l.startsWith('##[endgroup]') && l.trim() !== '')
				.map(l => l.replace(/^##\[error]/, 'ERROR: '))
			return `Step "${section.name}":\n${prioritizeFailures(content)}`
		}).join('\n\n')
		return output.slice(-8000)
	}

	const cleanedLines = lines
		.filter(l => !l.startsWith('##[group]') && !l.startsWith('##[endgroup]') && l.trim() !== '')
		.map(l => l.replace(/^##\[error]/, 'ERROR: '))

	return prioritizeFailures(cleanedLines)
}

export function extractCoverageFromLogs(logText: string): string | null {
	const parsed = parseStepSections(logText)
	const stepSections = parsed.map(({ name, start, end }) => ({ name, start, end }))
	const lines = parsed[0]?.lines ?? logText.split('\n').map(stripLogLine)

	const coverageSection = stepSections.find(s =>
		s.name === 'Coverage' || s.name === 'Run Coverage' || s.name.includes('Coverage')
	)
	if (!coverageSection) return null

	const sectionLines = lines.slice(coverageSection.start, coverageSection.end)
		.filter(l => !l.startsWith('##[') && l.trim() !== '')

	const jsonLine = sectionLines.find(l => l.trim().startsWith('{') && l.includes('"total"'))
	if (!jsonLine) return null

	try {
		const data = JSON.parse(jsonLine.trim()) as CoverageSummaryJson
		return formatCoverageSummary(data)
	} catch {
		return null
	}
}

function formatCoverageSummary(data: CoverageSummaryJson): string {
	const t = data.total
	const parts: string[] = [
		`Coverage: ${t.statements.pct}% statements, ${t.branches.pct}% branches, ${t.functions.pct}% functions, ${t.lines.pct}% lines`,
	]

	const fileEntries = Object.entries(data)
		.filter(([key]) => key !== 'total')
		.map(([filePath, cov]) => ({ filePath, pct: cov.statements.pct }))
		.sort((a, b) => a.pct - b.pct)

	const lowCoverage = fileEntries.filter(f => f.pct < 50)
	if (lowCoverage.length > 0) {
		const listed = lowCoverage.slice(0, config.coverage.maxLowCoverageFiles).map(f => `${f.filePath} (${f.pct}%)`).join(', ')
		parts.push(`Low coverage (<50%): ${listed}`)
	}

	const zeroCoverage = fileEntries.filter(f => f.pct === 0)
	if (zeroCoverage.length > 0) {
		parts.push(`Untested files: ${zeroCoverage.length}`)
	}

	return parts.join('\n')
}
