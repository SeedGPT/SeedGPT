import mongoose, { type Document, type Model, Schema } from 'mongoose'

export interface IMemory extends Document {
	content: string
	summary: string
	pinned: boolean
	ideaStatus?: 'pending' | 'attempted' | 'completed'
	ideaContext?: string
	createdAt: Date
	updatedAt: Date
}

const memorySchema = new Schema<IMemory>({
	content: {
		type: String,
		required: true,
	},
	summary: {
		type: String,
		required: true,
	},
	pinned: {
		type: Boolean,
		default: false,
	},
	ideaStatus: {
		type: String,
		enum: ['pending', 'attempted', 'completed'],
		required: false,
	},
	ideaContext: {
		type: String,
		required: false,
	},
}, {
	timestamps: true,
})

memorySchema.index({ pinned: 1, createdAt: -1 }) // getContext: fetch pinned notes sorted by date
memorySchema.index({ createdAt: -1 })              // getContext: fetch recent unpinned memories
memorySchema.index({ content: 'text', summary: 'text' }) // recall: full-text search across memories

const MemoryModel: Model<IMemory> = mongoose.model<IMemory>('Memory', memorySchema)

export default MemoryModel
