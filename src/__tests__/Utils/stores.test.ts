import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import type { GroupMetadata, WAMessage } from '../../Types'
import { makeGroupMetadataCache } from '../../Utils/group-cache'
import { type HelperSocket, makeHelpers, type SendResult } from '../../Utils/helpers'
import { makeMessageStore } from '../../Utils/message-store'

const msg = (id: string, text = 'hola') =>
	({ key: { remoteJid: '1@s.whatsapp.net', id }, message: { conversation: text } }) as WAMessage

describe('makeMessageStore', () => {
	it('returns saved messages by id and ignores empty ones', () => {
		const store = makeMessageStore()
		store.save(msg('A'))
		store.save({ key: { id: 'B' }, message: null })
		store.save(undefined)

		expect(store.get({ id: 'A' })).toEqual({ conversation: 'hola' })
		expect(store.get({ id: 'B' })).toBeUndefined()
		expect(store.size).toBe(1)
	})

	it('drops the oldest messages past `max`', () => {
		const store = makeMessageStore({ max: 2 })
		for (const id of ['A', 'B', 'C']) store.save(msg(id))
		expect(store.get({ id: 'A' })).toBeUndefined()
		expect(store.get({ id: 'C' })).toBeDefined()
		expect(store.size).toBe(2)
	})

	it('saving again refreshes a message instead of duplicating it', () => {
		const store = makeMessageStore({ max: 2 })
		store.save(msg('A'))
		store.save(msg('B'))
		store.save(msg('A', 'editado'))
		store.save(msg('C'))
		expect(store.get({ id: 'A' })).toEqual({ conversation: 'editado' })
		expect(store.get({ id: 'B' })).toBeUndefined()
	})
})

describe('makeGroupMetadataCache', () => {
	const group = (id: string) => ({ id, participants: [] }) as unknown as GroupMetadata

	it('expires entries after the ttl', () => {
		let clock = 0
		const cache = makeGroupMetadataCache({ ttlMs: 1000, now: () => clock })
		cache.set('g@g.us', group('g@g.us'))
		clock = 999
		expect(cache.get('g@g.us')).toBeDefined()
		clock = 1001
		expect(cache.get('g@g.us')).toBeUndefined()
		expect(cache.size).toBe(0)
	})

	it('can forget a group and respects `max`', () => {
		const cache = makeGroupMetadataCache({ max: 2 })
		for (const id of ['a', 'b', 'c']) cache.set(id, group(id))
		expect(cache.get('a')).toBeUndefined()
		cache.delete('b')
		expect(cache.get('b')).toBeUndefined()
		expect(cache.get('c')).toBeDefined()
	})
})

describe('sendSafe', () => {
	const make = (sendMessage: HelperSocket['sendMessage']) =>
		makeHelpers({
			ev: { on: () => undefined, emit: () => undefined },
			sendMessage,
			updateMediaMessage: jest.fn()
		} as unknown as HelperSocket)

	it('reports sent', async () => {
		const helpers = make(async () => msg('OK'))
		const result = await helpers.sendSafe('1@s.whatsapp.net', 'hola')
		expect(result.status).toBe('sent')
	})

	it('reports failed for definite errors', async () => {
		const helpers = make(async () => {
			throw new Boom('nope', { statusCode: 400 })
		})
		expect((await helpers.sendSafe('1@s.whatsapp.net', 'hola')).status).toBe('failed')
	})

	it('reports unknown when the connection closes mid-send', async () => {
		const helpers = make(async () => {
			throw new Boom('closed', { statusCode: 428 })
		})
		const result = await helpers.sendSafe('1@s.whatsapp.net', 'hola')
		expect(result.status).toBe('unknown')
	})

	it('reports unknown on timeout and still gives the final outcome', async () => {
		let finish!: (m: WAMessage) => void
		const helpers = make(() => new Promise<WAMessage>(resolve => (finish = resolve)))

		const result = await helpers.sendSafe('1@s.whatsapp.net', 'hola', undefined, { timeoutMs: 10 })
		expect(result.status).toBe('unknown')

		finish(msg('LATE'))
		const final: SendResult = await (result as Extract<SendResult, { status: 'unknown' }>).settled
		expect(final.status).toBe('sent')
	})
})
