import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import type { WAMessage } from '../../Types'
import { makeInsights } from '../../Utils/insights'

const setup = (extra = {}) => {
	const ev = new EventEmitter()
	const query = jest.fn(async () => ({}))
	let time = 1_000
	let tick = 0
	const insights = makeInsights({ ev, query } as never, {
		now: () => time,
		clock: () => (tick += 42),
		queueSize: () => 3,
		...extra
	})
	return { ev, insights, query, advance: (ms: number) => (time += ms) }
}

const incoming = (message: WAMessage['message']) =>
	({ key: { remoteJid: '1@s.whatsapp.net', id: Math.random().toString() }, message }) as WAMessage

describe('stats', () => {
	it('counts received messages by type, ignoring own and non-notify ones', () => {
		const { ev, insights } = setup()
		ev.emit('messages.upsert', {
			type: 'notify',
			messages: [
				incoming({ conversation: 'hola' }),
				incoming({ imageMessage: {} }),
				{ ...incoming({ conversation: 'mio' }), key: { remoteJid: 'x', id: '1', fromMe: true } }
			]
		})
		ev.emit('messages.upsert', { type: 'append', messages: [incoming({ conversation: 'viejo' })] })

		const stats = insights.getStats()
		expect(stats.received).toBe(2)
		expect(stats.receivedByType).toEqual({ conversation: 1, imageMessage: 1 })
	})

	it('counts sent and failed messages through wrapSend, by kind', async () => {
		const { insights } = setup()
		const send = insights.wrapSend(async (_jid, content) => {
			if (content.fail) throw new Error('nope')
			return undefined
		})

		await send('1@s.whatsapp.net', { text: 'a' })
		await send('1@s.whatsapp.net', { image: Buffer.alloc(1) })
		await send('1@s.whatsapp.net', { react: { text: '🔥' } })
		await expect(send('1@s.whatsapp.net', { text: 'b', fail: true })).rejects.toThrow('nope')

		expect(insights.getStats()).toMatchObject({
			sent: 3,
			failed: 1,
			sentByType: { text: 1, image: 1, react: 1 }
		})

		insights.resetStats()
		expect(insights.getStats()).toMatchObject({ sent: 0, received: 0, failed: 0, sentByType: {} })
	})
})

describe('message.status', () => {
	const statuses = (ev: EventEmitter) => {
		const seen: string[] = []
		ev.on('message.status', (event: { status: string; userJid?: string }) =>
			seen.push(event.userJid ? `${event.status}:${event.userJid}` : event.status)
		)
		return seen
	}
	const update = (status: number, id = 'M1', fromMe = true) => [
		{ key: { remoteJid: '1@s.whatsapp.net', id, fromMe }, update: { status } }
	]

	it('reports progress only forward and remembers the last state', () => {
		const { ev, insights } = setup()
		const seen = statuses(ev)

		ev.emit('messages.update', update(2))
		ev.emit('messages.update', update(3))
		ev.emit('messages.update', update(3)) // repeated
		ev.emit('messages.update', update(2)) // a step back
		ev.emit('messages.update', update(4))

		expect(seen).toEqual(['sent', 'delivered', 'read'])
		expect(insights.getMessageStatus('M1')).toBe('read')
		expect(insights.getMessageStatus({ id: 'nada' })).toBeUndefined()
	})

	it('ignores messages from others and reports failures', () => {
		const { ev } = setup()
		const seen = statuses(ev)
		ev.emit('messages.update', update(4, 'M2', false))
		ev.emit('messages.update', update(0, 'M3'))
		expect(seen).toEqual(['failed'])
	})

	it('reports group receipts per member', () => {
		const { ev } = setup()
		const seen = statuses(ev)
		const key = { remoteJid: '1203@g.us', id: 'G1', fromMe: true }
		ev.emit('message-receipt.update', [
			{ key, receipt: { userJid: 'a@s.whatsapp.net', receiptTimestamp: 1 } },
			{ key, receipt: { userJid: 'b@s.whatsapp.net', readTimestamp: 2 } }
		])
		expect(seen).toEqual(['delivered:a@s.whatsapp.net', 'read:b@s.whatsapp.net'])
	})
})

describe('health', () => {
	it('measures a real ping while connected', async () => {
		const { ev, insights, query, advance } = setup()
		ev.emit('connection.update', { connection: 'open' })
		advance(5_000)

		const report = await insights.health()
		expect(query).toHaveBeenCalledTimes(1)
		expect(report).toMatchObject({
			state: 'open',
			uptimeMs: 5_000,
			connectedMs: 5_000,
			reconnects: 0,
			queueSize: 3,
			latencyMs: 42
		})
		expect(report.memory.rssMB).toBeGreaterThan(0)
	})

	it('counts reconnects and skips the ping when it is not connected', async () => {
		const { ev, insights, query } = setup()
		ev.emit('connection.update', { connection: 'open' })
		ev.emit('connection.update', { connection: 'close' })
		ev.emit('connection.update', { connection: 'open' })
		expect((await insights.health({ ping: false })).reconnects).toBe(1)

		ev.emit('connection.update', { connection: 'close' })
		const report = await insights.health()
		expect(report).toMatchObject({
			state: 'closed',
			connectedMs: undefined,
			latencyMs: undefined,
			pingError: 'not connected'
		})
		expect(query).not.toHaveBeenCalled()
	})

	it('reports a failed ping instead of throwing', async () => {
		const { ev, insights, query } = setup()
		ev.emit('connection.update', { connection: 'open' })
		query.mockRejectedValueOnce(new Error('timed out'))
		const report = await insights.health()
		expect(report.latencyMs).toBeUndefined()
		expect(report.pingError).toBe('timed out')
	})
})
