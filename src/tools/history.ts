import GeneratedModel from '../models/Generated.js'
import logger from '../logger.js'

export async function queryIterationHistory(limit: number = 5): Promise<string> {
	logger.debug(`Querying iteration history with limit ${limit}`)

	// Aggregate to group by iterationId and get phases and timing info
	const iterations = await GeneratedModel.aggregate([
		{ $match: { iterationId: { $ne: '' } } },
		{
			$group: {
				_id: '$iterationId',
				phases: { $addToSet: '$phase' },
				firstCreated: { $min: '$createdAt' },
				lastCreated: { $max: '$createdAt' },
				messages: { $first: '$messages' },
			},
		},
		{ $sort: { firstCreated: -1 } },
		{ $limit: limit },
	])

	if (iterations.length === 0) {
		return 'No iteration history found.'
	}

	const summaries: string[] = []
	for (const iteration of iterations) {
		const iterationId = iteration._id.slice(0, 8)
		const date = new Date(iteration.firstCreated).toISOString().slice(0, 19).replace('T', ' ')
		
		// Iteration is considered complete if reflect phase exists
		const outcome = iteration.phases.includes('reflect') ? 'completed' : 'failed'
		
		// Extract description from planner messages
		let description = 'Unknown'
		try {
			const messages = iteration.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }> }>
			for (const msg of messages) {
				if (typeof msg.content === 'string') {
					// Simple text content
					if (msg.content.length > 10) {
						description = msg.content.slice(0, 100).replace(/\n/g, ' ')
						break
					}
				} else if (Array.isArray(msg.content)) {
					// Tool use or text blocks
					for (const block of msg.content) {
						if (block.type === 'tool_use' && block.name === 'submit_plan') {
							const input = block.input as { title?: string }
							if (input?.title) {
								description = input.title
								break
							}
						} else if (block.type === 'text' && block.text && block.text.length > 10) {
							description = block.text.slice(0, 100).replace(/\n/g, ' ')
							break
						}
					}
					if (description !== 'Unknown') break
				}
			}
		} catch (err) {
			logger.debug(`Could not extract description for iteration ${iterationId}: ${err}`)
		}
		
		summaries.push(`- ${iterationId} [${date}] ${outcome}: ${description}`)
	}

	return summaries.join('\n')
}
