import { describe, it, expect } from '@jest/globals'
import { computeCost, stripSignature, stripSignaturesFromRecord } from './Generated.js'

describe('computeCost', () => {
	it('computes cost for claude-sonnet-4-6 without caching', () => {
		const cost = computeCost('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
		expect(cost).toBe(3 + 15)
	})

	it('computes cost for claude-haiku-4-5', () => {
		const cost = computeCost('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
		expect(cost).toBe(1 + 5)
	})

	it('computes cost for claude-opus-4-6', () => {
		const cost = computeCost('claude-opus-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
		expect(cost).toBe(5 + 25)
	})

	it('uses default pricing for unknown models', () => {
		const cost = computeCost('unknown-model', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
		expect(cost).toBe(5 + 25)
	})

	it('computes fractional costs correctly', () => {
		const cost = computeCost('claude-haiku-4-5', { input_tokens: 500, output_tokens: 200 })
		expect(cost).toBeCloseTo(500 * 1 / 1_000_000 + 200 * 5 / 1_000_000)
	})

	it('returns 0 for zero tokens', () => {
		expect(computeCost('claude-sonnet-4-6', { input_tokens: 0, output_tokens: 0 })).toBe(0)
	})

	it('applies cache read rate', () => {
		const cost = computeCost('claude-sonnet-4-6', {
			input_tokens: 1_000_000,
			output_tokens: 0,
			cache_read_input_tokens: 800_000,
			cache_creation_input_tokens: 0,
		})
		const expected = (200_000 * 3 + 800_000 * 0.30) / 1_000_000
		expect(cost).toBeCloseTo(expected)
	})

	it('applies 5m cache write rate by default', () => {
		const cost = computeCost('claude-sonnet-4-6', {
			input_tokens: 1_000_000,
			output_tokens: 0,
			cache_creation_input_tokens: 500_000,
			cache_read_input_tokens: 0,
		})
		const expected = (500_000 * 3 + 500_000 * 3.75) / 1_000_000
		expect(cost).toBeCloseTo(expected)
	})

	it('uses 1h cache write rate when cache_creation breakdown provided', () => {
		const cost = computeCost('claude-sonnet-4-6', {
			input_tokens: 1_000_000,
			output_tokens: 0,
			cache_creation_input_tokens: 500_000,
			cache_read_input_tokens: 0,
			cache_creation: { ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 300_000 },
		})
		const expected = (500_000 * 3 + 200_000 * 3.75 + 300_000 * 6) / 1_000_000
		expect(cost).toBeCloseTo(expected)
	})

	it('handles mixed cache read, 5m write, and 1h write', () => {
		const cost = computeCost('claude-haiku-4-5', {
			input_tokens: 1_000_000,
			output_tokens: 100_000,
			cache_creation_input_tokens: 200_000,
			cache_read_input_tokens: 300_000,
			cache_creation: { ephemeral_5m_input_tokens: 150_000, ephemeral_1h_input_tokens: 50_000 },
		})
		const expectedInput = 500_000 * 1 + 150_000 * 1.25 + 50_000 * 2 + 300_000 * 0.10
		const expectedOutput = 100_000 * 5
		expect(cost).toBeCloseTo((expectedInput + expectedOutput) / 1_000_000)
	})

	it('applies 50% batch discount', () => {
		const regular = computeCost('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
		const batch = computeCost('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, { batch: true })
		expect(batch).toBe(regular * 0.5)
	})

	it('stacks batch discount with cache pricing', () => {
		const usage = {
			input_tokens: 1_000_000,
			output_tokens: 0,
			cache_read_input_tokens: 800_000,
			cache_creation_input_tokens: 0,
		}
		const regular = computeCost('claude-sonnet-4-6', usage)
		const batch = computeCost('claude-sonnet-4-6', usage, { batch: true })
		expect(batch).toBeCloseTo(regular * 0.5)
	})
})

describe('stripSignature', () => {
	it('removes signature from a thinking block', () => {
		const block = { type: 'thinking', thinking: 'some thought', signature: 'abc123' }
		const result = stripSignature(block)
		expect(result).toEqual({ type: 'thinking', thinking: 'some thought' })
	})

	it('returns thinking block unchanged when no signature field', () => {
		const block = { type: 'thinking', thinking: 'some thought' }
		const result = stripSignature(block)
		expect(result).toEqual({ type: 'thinking', thinking: 'some thought' })
	})

	it('returns non-thinking block unchanged', () => {
		const block = { type: 'text', text: 'hello', signature: 'shouldStay' }
		const result = stripSignature(block)
		expect(result).toEqual({ type: 'text', text: 'hello', signature: 'shouldStay' })
	})
})

describe('stripSignaturesFromRecord', () => {
	it('strips signature from thinking block in assistant message content', () => {
		const doc = {
			messages: [
				{ role: 'assistant', content: [{ type: 'thinking', thinking: 'thought', signature: 'sig1' }] },
			],
			response: [],
		}
		stripSignaturesFromRecord(doc)
		expect((doc.messages as { role: string; content: { type: string; thinking: string }[] }[])[0].content[0]).toEqual({ type: 'thinking', thinking: 'thought' })
	})

	it('leaves non-assistant messages unchanged', () => {
		const doc = {
			messages: [
				{ role: 'user', content: [{ type: 'thinking', signature: 'sig' }] },
			],
			response: [],
		}
		stripSignaturesFromRecord(doc)
		expect((doc.messages as { role: string; content: { signature: string }[] }[])[0].content[0]).toEqual({ type: 'thinking', signature: 'sig' })
	})

	it('strips signature from thinking block in response', () => {
		const doc = {
			messages: [],
			response: [{ type: 'thinking', thinking: 'resp thought', signature: 'sig2' }],
		}
		stripSignaturesFromRecord(doc)
		expect((doc.response as { type: string; thinking: string }[])[0]).toEqual({ type: 'thinking', thinking: 'resp thought' })
	})

	it('does not throw when messages or response is not an array', () => {
		const doc = { messages: null, response: null }
		expect(() => stripSignaturesFromRecord(doc as unknown as { messages: unknown; response: unknown })).not.toThrow()
	})
})
