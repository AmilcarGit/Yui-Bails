import { jest } from '@jest/globals'
import { makeSendQueue } from '../../Utils/send-queue'

const setup = (options = {}) => {
	let clock = 1_000_000
	const sleeps: number[] = []
	const calls: string[] = []
	const sock = {
		sendMessage: jest.fn(async (jid: string, content: any) => {
			calls.push(`send:${jid}:${content.text ?? ''}`)
			return { key: { id: String(calls.length) } } as any
		}),
		sendPresenceUpdate: jest.fn(async (type: string, jid?: string) => {
			calls.push(`${type}:${jid}`)
		})
	}
	const queue = makeSendQueue(sock as any, {
		random: () => 0,
		now: () => clock,
		sleep: async ms => {
			sleeps.push(ms)
			clock += ms
		},
		...options
	})
	return { queue, sock, calls, sleeps, advance: (ms: number) => (clock += ms) }
}

describe('makeSendQueue', () => {
	it('sends in order, one at a time, with typing before text', async () => {
		const { queue, calls } = setup()
		await Promise.all([
			queue.sendMessage('a@s.whatsapp.net', { text: 'uno' }),
			queue.sendMessage('a@s.whatsapp.net', { text: 'dos' })
		])
		expect(calls).toEqual([
			'composing:a@s.whatsapp.net',
			'paused:a@s.whatsapp.net',
			'send:a@s.whatsapp.net:uno',
			'composing:a@s.whatsapp.net',
			'paused:a@s.whatsapp.net',
			'send:a@s.whatsapp.net:dos'
		])
	})

	it('pauses between sends and respects the per-chat interval', async () => {
		const { queue, sleeps } = setup({ minDelayMs: 100, maxDelayMs: 100, perChatIntervalMs: 5000, typing: false })
		await queue.sendMessage('a@s.whatsapp.net', { text: '1' })
		await queue.sendMessage('a@s.whatsapp.net', { text: '2' })
		expect(sleeps).toEqual([5000])
	})

	it('skips typing for reactions, non-text content and status broadcasts', async () => {
		const { queue, sock } = setup()
		await queue.sendMessage('a@s.whatsapp.net', { react: { text: '🔥', key: {} } })
		await queue.sendMessage('a@s.whatsapp.net', { image: Buffer.alloc(1) })
		await queue.sendMessage('status@broadcast', { text: 'estado' })
		expect(sock.sendPresenceUpdate).not.toHaveBeenCalled()
	})

	it('holds messages once a chat reaches its window limit', async () => {
		const { queue, sleeps } = setup({
			minDelayMs: 0,
			maxDelayMs: 0,
			perChatIntervalMs: 0,
			typing: false,
			perChatLimit: { max: 2, windowMs: 10_000 }
		})
		for (let i = 0; i < 3; i++) await queue.sendMessage('a@s.whatsapp.net', { text: String(i) })
		expect(sleeps).toEqual([10_000])
	})

	it('keeps going after a failed send and rejects only that call', async () => {
		const { queue, sock } = setup({ typing: false })
		sock.sendMessage.mockRejectedValueOnce(new Error('network'))
		const first = queue.sendMessage('a@s.whatsapp.net', { text: '1' })
		const second = queue.sendMessage('a@s.whatsapp.net', { text: '2' })
		await expect(first).rejects.toThrow('network')
		await expect(second).resolves.toBeDefined()
	})

	it('does not fail a message when the typing indicator fails', async () => {
		const { queue, sock } = setup()
		sock.sendPresenceUpdate.mockRejectedValue(new Error('no presence'))
		await expect(queue.sendMessage('a@s.whatsapp.net', { text: 'hola' })).resolves.toBeDefined()
	})

	it('rejects when the queue is full and clear() drops waiting messages', async () => {
		const { queue } = setup({ maxQueueSize: 1, typing: false })
		const a = queue.sendMessage('a@s.whatsapp.net', { text: '1' })
		const b = queue.sendMessage('a@s.whatsapp.net', { text: '2' })
		const c = queue.sendMessage('a@s.whatsapp.net', { text: '3' })
		// clear synchronously: `a` is already being sent, `b` is still waiting
		expect(queue.queue.clear()).toBe(1)
		await expect(c).rejects.toThrow('full')
		await expect(b).rejects.toThrow('cleared')
		await expect(a).resolves.toBeDefined()
	})

	it('sendMessageNow bypasses the queue', async () => {
		const { queue, sock, sleeps } = setup()
		await queue.sendMessageNow('a@s.whatsapp.net', { text: 'ya' })
		expect(sock.sendMessage).toHaveBeenCalledTimes(1)
		expect(sleeps).toEqual([])
	})
	describe('priority', () => {
		const sentTexts = (sock: { sendMessage: jest.Mock<any> }) =>
			sock.sendMessage.mock.calls.map(call => (call[1] as { text: string }).text)

		it('urgent and high messages jump ahead of waiting ones; equal priority keeps its order', async () => {
			const { queue, sock } = setup({ typing: false })
			const all = [
				queue.sendMessage('a@s.whatsapp.net', { text: 'first' }),
				queue.sendMessage('a@s.whatsapp.net', { text: 'low' }, { priority: 'low' }),
				queue.sendMessage('a@s.whatsapp.net', { text: 'normal 1' }),
				queue.sendMessage('a@s.whatsapp.net', { text: 'normal 2' }),
				queue.sendMessage('a@s.whatsapp.net', { text: 'high' }, { priority: 'high' }),
				queue.sendMessage('a@s.whatsapp.net', { text: 'urgent' }, { priority: 'urgent' })
			]
			await Promise.all(all)

			expect(sentTexts(sock)).toEqual(['first', 'urgent', 'high', 'normal 1', 'normal 2', 'low'])
		})

		it('never sends `priority` to WhatsApp, but keeps the other options', async () => {
			const { queue, sock } = setup({ typing: false })
			await queue.sendMessage('a@s.whatsapp.net', { text: 'x' }, { priority: 'high', ephemeralExpiration: 60 })

			const options = (sock.sendMessage.mock.calls[0] as unknown[])[2] as Record<string, unknown>
			expect(options).toEqual({ ephemeralExpiration: 60 })
			expect('priority' in options).toBe(false)
		})

		it('urgent messages skip the typing indicator', async () => {
			const { queue, sock } = setup()
			await queue.sendMessage('a@s.whatsapp.net', { text: 'rápido' }, { priority: 'urgent' })
			expect(sock.sendPresenceUpdate).not.toHaveBeenCalled()
		})
	})
})
