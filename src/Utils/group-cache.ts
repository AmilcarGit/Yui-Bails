import type { GroupMetadata } from '../Types'

export type GroupCacheOptions = {
	/** how long a group's data is trusted, in ms. Default 5 minutes */
	ttlMs?: number
	/** how many groups to keep. Default 500 */
	max?: number
	/** replaceable clock, for tests */
	now?: () => number
}

/**
 * In-memory cache of group metadata. Sending to a group needs its member list; without a cache
 * every send asks WhatsApp for it, which gets accounts rate-limited.
 */
export const makeGroupMetadataCache = ({ ttlMs = 5 * 60_000, max = 500, now = Date.now }: GroupCacheOptions = {}) => {
	const groups = new Map<string, { data: GroupMetadata; at: number }>()

	return {
		get: (jid: string) => {
			const entry = groups.get(jid)
			if (!entry) return undefined
			if (now() - entry.at > ttlMs) {
				groups.delete(jid)
				return undefined
			}

			return entry.data
		},
		set: (jid: string, data: GroupMetadata) => {
			groups.delete(jid)
			groups.set(jid, { data, at: now() })
			if (groups.size > max) groups.delete(groups.keys().next().value as string)
		},
		delete: (jid: string) => groups.delete(jid),
		clear: () => groups.clear(),
		get size() {
			return groups.size
		}
	}
}

export type GroupMetadataCache = ReturnType<typeof makeGroupMetadataCache>
