import type { GroupMetadata } from '../Types'
import type { GroupMetadataCache } from './group-cache'

export type GroupFetchOptions = {
	/** retries after a "rate-overlimit", timed out or empty answer. Default 3 */
	retries?: number
	/** first wait in ms, doubled each retry. Default 2000 */
	baseDelayMs?: number
	/** replaceable for tests */
	sleep?: (ms: number) => Promise<void>
}

/** WhatsApp answers 429 / "rate-overlimit" when it is asked for too much too fast */
export const isRateLimited = (error: unknown): boolean => {
	const err = error as { data?: unknown; message?: string; output?: { statusCode?: number } } | undefined
	return err?.data === 429 || err?.output?.statusCode === 429 || /rate-overlimit/i.test(err?.message || '')
}

/**
 * Failures that usually pass by themselves: WhatsApp's rate limit, a slow answer, or an empty answer
 * (no `<group>` node) that shows up when the connection is busy or has just been restored.
 */
export const isTransient = (error: unknown): boolean => {
	const err = error as { message?: string; output?: { statusCode?: number } } | undefined
	return (
		isRateLimited(error) ||
		err?.output?.statusCode === 408 ||
		/timed out|missing <group> node/i.test(err?.message || '')
	)
}

/**
 * Makes `groupMetadata` safe to call often: answers from the cache when it can, shares one request
 * between simultaneous callers of the same group, and waits and retries when WhatsApp says
 * "rate-overlimit" (or answers late or empty) instead of failing right away.
 */
export const makeGroupFetcher = (
	fetchGroup: (jid: string) => Promise<GroupMetadata>,
	cache: GroupMetadataCache | undefined,
	{ retries = 3, baseDelayMs = 2000, sleep }: GroupFetchOptions = {}
) => {
	const wait = sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
	const pending = new Map<string, Promise<GroupMetadata>>()

	const fetchWithRetry = async (jid: string) => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await fetchGroup(jid)
			} catch (error) {
				if (!isTransient(error) || attempt >= retries) throw error
				await wait(baseDelayMs * 2 ** attempt)
			}
		}
	}

	return (jid: string): Promise<GroupMetadata> => {
		const cached = cache?.get(jid)
		if (cached) return Promise.resolve(cached)

		const running = pending.get(jid)
		if (running) return running

		const request = fetchWithRetry(jid)
			.then(data => {
				cache?.set(jid, data)
				return data
			})
			.finally(() => pending.delete(jid))
		pending.set(jid, request)
		return request
	}
}
