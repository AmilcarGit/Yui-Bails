import type { WAMessage, WAMessageKey } from '../Types'

export type MessageStoreOptions = {
	/** how many messages to keep (oldest are dropped first). Default 1000 */
	max?: number
}

/**
 * Small in-memory store of recent messages. WhatsApp asks for the original message when a
 * delivery fails and has to be retried (`getMessage`); keeping the latest ones here makes that
 * work without any setup.
 */
export const makeMessageStore = ({ max = 1000 }: MessageStoreOptions = {}) => {
	const messages = new Map<string, NonNullable<WAMessage['message']>>()

	return {
		/** remembers the content of a message (messages without content are ignored) */
		save: (msg: Pick<WAMessage, 'key' | 'message'> | null | undefined) => {
			const id = msg?.key?.id
			if (!id || !msg.message) return

			messages.delete(id) // re-inserting keeps the newest at the end
			messages.set(id, msg.message)
			if (messages.size > max) messages.delete(messages.keys().next().value as string)
		},
		get: (key: Pick<WAMessageKey, 'id'>) => (key?.id ? messages.get(key.id) : undefined),
		get size() {
			return messages.size
		},
		clear: () => messages.clear()
	}
}

export type MessageStore = ReturnType<typeof makeMessageStore>
