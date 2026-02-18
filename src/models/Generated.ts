import mongoose, { type Document, type Model, Schema } from 'mongoose'

// IMPORTANT: This model is for logging all API interactions for auditing and analysis by the operator. It should not be used for any real-time logic or features, as it contains a lot of chars and is not optimized for performance.

interface ModelPricing {
	inputPerMTok: number
	cacheWrite5mPerMTok: number
	cacheWrite1hPerMTok: number
	cacheReadPerMTok: number
	outputPerMTok: number
}

const PRICING: Record<string, ModelPricing> = {
	'claude-opus-4-6':   { inputPerMTok: 5,    cacheWrite5mPerMTok: 6.25,  cacheWrite1hPerMTok: 10,   cacheReadPerMTok: 0.50, outputPerMTok: 25   },
	'claude-sonnet-4-6': { inputPerMTok: 3,    cacheWrite5mPerMTok: 3.75,  cacheWrite1hPerMTok: 6,    cacheReadPerMTok: 0.30, outputPerMTok: 15   },
	'claude-haiku-4-5':  { inputPerMTok: 1,    cacheWrite5mPerMTok: 1.25,  cacheWrite1hPerMTok: 2,    cacheReadPerMTok: 0.10, outputPerMTok: 5    },
}

const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 5, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.50, outputPerMTok: 25 }

export interface ApiUsage {
	input_tokens: number
	output_tokens: number
	cache_creation_input_tokens?: number | null
	cache_read_input_tokens?: number | null
	cache_creation?: {
		ephemeral_5m_input_tokens: number
		ephemeral_1h_input_tokens: number
	} | null
}

export function computeCost(model: string, usage: ApiUsage, options?: { batch?: boolean }): number {
	const pricing = PRICING[model] ?? DEFAULT_PRICING

	const totalCacheWrite = usage.cache_creation_input_tokens ?? 0
	const cacheRead = usage.cache_read_input_tokens ?? 0

	let cacheWrite5m: number
	let cacheWrite1h: number
	if (usage.cache_creation) {
		cacheWrite5m = usage.cache_creation.ephemeral_5m_input_tokens
		cacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens
	} else {
		cacheWrite5m = totalCacheWrite
		cacheWrite1h = 0
	}

	const uncached = Math.max(0, usage.input_tokens - totalCacheWrite - cacheRead)

	const inputCost = uncached * pricing.inputPerMTok
		+ cacheWrite5m * pricing.cacheWrite5mPerMTok
		+ cacheWrite1h * pricing.cacheWrite1hPerMTok
		+ cacheRead * pricing.cacheReadPerMTok
	const outputCost = usage.output_tokens * pricing.outputPerMTok

	const total = (inputCost + outputCost) / 1_000_000
	return options?.batch ? total * 0.5 : total
}

export interface IGenerated extends Document {
	phase: string
	modelId: string
	iterationId: string
	system: unknown[]
	messages: unknown[]
	response: unknown[]
	inputTokens: number
	outputTokens: number
	cacheWrite5mTokens: number
	cacheWrite1hTokens: number
	cacheReadTokens: number
	cost: number
	batch: boolean
	stopReason: string
	createdAt: Date
}

const generatedSchema = new Schema<IGenerated>({
	phase: { type: String, required: true },
	modelId: { type: String, required: true },
	iterationId: { type: String, default: '' },
	system: { type: Schema.Types.Mixed, required: true },
	messages: { type: Schema.Types.Mixed, required: true },
	response: { type: Schema.Types.Mixed, required: true },
	inputTokens: { type: Number, required: true },
	outputTokens: { type: Number, required: true },
	cacheWrite5mTokens: { type: Number, default: 0 },
	cacheWrite1hTokens: { type: Number, default: 0 },
	cacheReadTokens: { type: Number, default: 0 },
	cost: { type: Number, required: true },
	batch: { type: Boolean, default: false },
	stopReason: { type: String, required: true },
}, {
	timestamps: { createdAt: true, updatedAt: false },
})

// Exported for testing only
export function stripSignature(block: Record<string, unknown>): Record<string, unknown> {
	if (block.type === 'thinking' && 'signature' in block) {
		const { signature: _, ...rest } = block
		return rest
	}
	return block
}

// Exported for testing only
export function stripSignaturesFromRecord(doc: { messages: unknown; response: unknown }): void {
	if (Array.isArray(doc.messages)) {
		doc.messages = (doc.messages as Record<string, unknown>[]).map(msg => {
			if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
			return { ...msg, content: (msg.content as Record<string, unknown>[]).map(stripSignature) }
		})
	}
	if (Array.isArray(doc.response)) {
		doc.response = (doc.response as Record<string, unknown>[]).map(stripSignature)
	}
}

generatedSchema.pre('save', function () {
	stripSignaturesFromRecord(this)
})

generatedSchema.index({ createdAt: -1 })
generatedSchema.index({ iterationId: 1 })

const GeneratedModel: Model<IGenerated> = mongoose.model<IGenerated>('Generated', generatedSchema)

export default GeneratedModel
