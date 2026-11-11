import { Boom } from '@hapi/boom'
import { describe, expect, it, jest } from '@jest/globals'
import type { GroupMetadata } from '../../Types'
import { makeGroupMetadataCache } from '../../Utils/group-cache'
import { isRateLimited, isTransient, makeGroupFetcher } from '../../Utils/group-fetch'

const group = (id: string) => ({ id, subject: 'Test' }) as GroupMetadata
const limited = () => Object.assign(new Boom('rate-overlimit'), { data: 429 })

describe('makeGroupFetcher', () => {
	it('detects rate limit errors', () => {
		expect(isRateLimited(limited())).toBe(true)
		expect(isRateLimited(new Error('boom'))).toBe(false)
	})

	it('treats slow and empty answers as transient, but not real errors', () => {
		expect(isTransient(limited())).toBe(true)
		expect(isTransient(new Boom('Timed Out', { statusCode: 408 }))).toBe(true)
		expect(isTransient(new Boom('Invalid group metadata response: missing <group> node'))).toBe(true)
		expect(isTransient(new Boom('forbidden', { statusCode: 403 }))).toBe(false)
		expect(isTransient(undefined)).toBe(false)
	})

	it('retries an empty answer (no <group> node)', async () => {
		const fetchGroup = jest
			.fn<(jid: string) => Promise<GroupMetadata>>()
			.mockRejectedValueOnce(new Boom('Invalid group metadata response: missing <group> node'))
			.mockResolvedValueOnce(group('a@g.us'))
		const get = makeGroupFetcher(fetchGroup, undefined, { sleep: async () => undefined })

		await expect(get('a@g.us')).resolves.toEqual(group('a@g.us'))
		expect(fetchGroup).toHaveBeenCalledTimes(2)
	})

	it('shares one request between simultaneous callers', async () => {
		const fetchGroup = jest.fn(async (jid: string) => group(jid))
		const get = makeGroupFetcher(fetchGroup, undefined)

		await Promise.all([get('a@g.us'), get('a@g.us'), get('a@g.us')])
		expect(fetchGroup).toHaveBeenCalledTimes(1)
	})

	it('answers from the cache', async () => {
		const fetchGroup = jest.fn(async (jid: string) => group(jid))
		const get = makeGroupFetcher(fetchGroup, makeGroupMetadataCache())

		await get('a@g.us')
		await get('a@g.us')
		expect(fetchGroup).toHaveBeenCalledTimes(1)
	})

	it('waits and retries on rate-overlimit', async () => {
		const waits: number[] = []
		let calls = 0
		const fetchGroup = async (jid: string) => {
			if (++calls < 3) throw limited()
			return group(jid)
		}

		const get = makeGroupFetcher(fetchGroup, undefined, { sleep: async ms => void waits.push(ms) })
		await expect(get('a@g.us')).resolves.toMatchObject({ id: 'a@g.us' })
		expect(waits).toEqual([2000, 4000])
	})

	it('gives up after the retries and does not retry other errors', async () => {
		const get = makeGroupFetcher(async () => Promise.reject(limited()), undefined, {
			retries: 1,
			sleep: async () => {}
		})
		await expect(get('a@g.us')).rejects.toThrow('rate-overlimit')

		const other = jest.fn(async () => Promise.reject(new Error('nope')))
		await expect(makeGroupFetcher(other, undefined)('a@g.us')).rejects.toThrow('nope')
		expect(other).toHaveBeenCalledTimes(1)
	})
})
