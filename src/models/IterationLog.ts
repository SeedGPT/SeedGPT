import mongoose, { type Document, type Model, Schema } from 'mongoose'

interface LogEntryDoc {
	timestamp: string
	level: string
	message: string
	context?: Record<string, unknown>
}

interface PhaseTokenUsage {
	input: number
	output: number
	cost: number
}

interface TokenUsage {
	planner: PhaseTokenUsage
	builder: PhaseTokenUsage
	reflect: PhaseTokenUsage
	total: PhaseTokenUsage
}

export interface IIterationLog extends Document {
	entries: LogEntryDoc[]
	tokenUsage?: TokenUsage
	createdAt: Date
}

const iterationLogSchema = new Schema<IIterationLog>({
	entries: [{
		timestamp: { type: String, required: true },
		level: { type: String, required: true },
		message: { type: String, required: true },
		context: { type: Schema.Types.Mixed },
	}],
	tokenUsage: {
		type: {
			planner: {
				input: Number,
				output: Number,
				cost: Number,
			},
			builder: {
				input: Number,
				output: Number,
				cost: Number,
			},
			reflect: {
				input: Number,
				output: Number,
				cost: Number,
			},
			total: {
				input: Number,
				output: Number,
				cost: Number,
			},
		},
		required: false,
	},
}, {
	timestamps: { createdAt: true, updatedAt: false },
})

iterationLogSchema.index({ createdAt: -1 })

const IterationLogModel: Model<IIterationLog> = mongoose.model<IIterationLog>('IterationLog', iterationLogSchema)

export default IterationLogModel
