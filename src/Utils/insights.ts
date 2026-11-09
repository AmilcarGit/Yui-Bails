import type { MessageUserReceiptUpdate, WAMessage, WAMessageKey, WAMessageUpdate } from '../Types'
import { getContentType } from './messages'

/** How far a message you sent got */
export type MessageDelivery = 'failed' | 'sent' | 'delivered' | 'read' | 'played'

export type MessageStatusEvent = {
	key: WAMessageKey
	status: MessageDelivery
	/** in groups, the member this receipt comes from */
	userJid?: string
	/** when the event was seen, ms since epoch */
	at: number
}

export type StatsSnapshot = {
	/** when counting started (or was reset), ms since epoch */
	since: number
	sent: number
	received: number
	/** sends that ended in an error */
	failed: number
	sentByType: Record<string, number>
	receivedByType: Record<string, number>
}

export type HealthReport = {
	state: 'connecting' | 'open' | 'closed'
	/** time since the socket was created, ms */
	uptimeMs: number
	/** time the current connection has been open, ms (undefined when it is not open) */
	connectedMs: number | undefined
	/** how many times the connection came back after dropping */
	reconnects: number
	/** messages waiting in the anti-ban queue */
	queueSize: number
	memory: { rssMB: number; heapUsedMB: number }
	/** round trip to WhatsApp's servers, measured now with a real ping (undefined when it was not measured) */
	latencyMs: number | undefined
	/** why the ping could not be measured */
	pingError?: string
}

type InsightSocket = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ev: { on: (event: any, listener: (...args: any[]) => void) => void; emit: (event: any, data: any) => unknown }
	query?: (
		node: { tag: string; attrs: Record<string, string>; content?: unknown },
		timeoutMs?: number
	) => Promise<unknown>
}

type SendFn = (jid: string, content: any, options?: any) => Promise<WAMessage | undefined>

export type InsightOptions = {
	/** messages waiting to be sent (the anti-ban queue) */
	queueSize?: () => number
	/** replaceable for tests */
	now?: () => number
	clock?: () => number
}

const RANK: Record<MessageDelivery, number> = { failed: 0, sent: 1, delivered: 2, read: 3, played: 4 }

// proto.WebMessageInfo.Status: ERROR 0 · PENDING 1 · SERVER_ACK 2 · DELIVERY_ACK 3 · READ 4 · PLAYED 5
const FROM_STATUS: Record<number, MessageDelivery | undefined> = {
	0: 'failed',
	2: 'sent',
	3: 'delivered',
	4: 'read',
	5: 'played'
}

const KINDS = [
	'text',
	'image',
	'video',
	'audio',
	'document',
	'sticker',
	'poll',
	'react',
	'location',
	'contacts',
	'carousel',
	'buttons',
	'sections',
	'nativeFlow',
	'album',
	'forward',
	'delete',
	'edit'
]

const kindOf = (content: unknown) => {
	if (!content || typeof content !== 'object') return 'other'
	return KINDS.find(kind => kind in content) || 'other'
}

const MAX_TRACKED = 2000
const MB = 1024 * 1024
const round = (value: number) => Math.round(value * 10) / 10

/**
 * Real numbers about a running bot: message counters, connection health with a measured ping,
 * and a `message.status` event telling how far each message you sent got.
 */
export const makeInsights = (sock: InsightSocket, options: InsightOptions = {}) => {
	const now = options.now || Date.now
	const clock = options.clock || (() => performance.now())

	const createdAt = now()
	let state: HealthReport['state'] = 'connecting'
	let openedAt: number | undefined
	let opens = 0

	let since = createdAt
	let sent = 0
	let received = 0
	let failed = 0
	let sentByType: Record<string, number> = {}
	let receivedByType: Record<string, number> = {}

	const delivery = new Map<string, MessageDelivery>()

	const bump = (counter: Record<string, number>, kind: string) => {
		counter[kind] = (counter[kind] || 0) + 1
	}

	const remember = (id: string, status: MessageDelivery) => {
		delivery.delete(id)
		delivery.set(id, status)
		if (delivery.size > MAX_TRACKED) delivery.delete(delivery.keys().next().value as string)
	}

	const announce = (key: WAMessageKey, status: MessageDelivery, userJid?: string) => {
		const id = key.id
		if (!id) return

		// only report progress (sent → delivered → read), never a step back
		const previous = delivery.get(id)
		if (!userJid && previous && RANK[status] <= RANK[previous] && status !== 'failed') return
		if (!userJid) remember(id, status)

		sock.ev.emit('message.status', { key, status, userJid, at: now() } satisfies MessageStatusEvent)
	}

	sock.ev.on('connection.update', ({ connection }: { connection?: string }) => {
		if (connection === 'open') {
			state = 'open'
			openedAt = now()
			opens += 1
		} else if (connection === 'close') {
			state = 'closed'
			openedAt = undefined
		} else if (connection === 'connecting') {
			state = 'connecting'
		}
	})

	sock.ev.on('messages.upsert', ({ messages, type }: { messages: WAMessage[]; type: string }) => {
		if (type !== 'notify') return

		for (const msg of messages) {
			if (msg.key.fromMe || !msg.message) continue
			received += 1
			bump(receivedByType, getContentType(msg.message) || 'other')
		}
	})

	sock.ev.on('messages.update', (updates: WAMessageUpdate[]) => {
		for (const { key, update } of updates) {
			const status = typeof update.status === 'number' ? FROM_STATUS[update.status] : undefined
			if (key.fromMe && status) announce(key, status)
		}
	})

	sock.ev.on('message-receipt.update', (updates: MessageUserReceiptUpdate[]) => {
		for (const { key, receipt } of updates) {
			const status: MessageDelivery | undefined = receipt.playedTimestamp
				? 'played'
				: receipt.readTimestamp
					? 'read'
					: receipt.receiptTimestamp
						? 'delivered'
						: undefined

			if (key.fromMe && status) announce(key, status, receipt.userJid || undefined)
		}
	})

	return {
		/** Wraps a send function so every send is counted (and failures too). */
		wrapSend:
			(send: SendFn): SendFn =>
			async (jid, content, sendOptions) => {
				const kind = kindOf(content)
				try {
					const result = await send(jid, content, sendOptions)
					sent += 1
					bump(sentByType, kind)
					return result
				} catch (error) {
					failed += 1
					throw error
				}
			},

		/** Counters since the socket started (or since the last `resetStats`). */
		getStats: (): StatsSnapshot => ({
			since,
			sent,
			received,
			failed,
			sentByType: { ...sentByType },
			receivedByType: { ...receivedByType }
		}),

		resetStats: () => {
			since = now()
			sent = received = failed = 0
			sentByType = {}
			receivedByType = {}
		},

		/** Last known delivery state of a message you sent (by id or key). */
		getMessageStatus: (message: string | Pick<WAMessageKey, 'id'>) =>
			delivery.get(typeof message === 'string' ? message : message.id || ''),

		/** Connection and process health. `ping: false` skips the network round trip. */
		health: async ({
			ping = true,
			timeoutMs = 5000
		}: { ping?: boolean; timeoutMs?: number } = {}): Promise<HealthReport> => {
			const memory = process.memoryUsage()
			const report: HealthReport = {
				state,
				uptimeMs: now() - createdAt,
				connectedMs: openedAt === undefined ? undefined : now() - openedAt,
				reconnects: Math.max(0, opens - 1),
				queueSize: options.queueSize?.() ?? 0,
				memory: { rssMB: round(memory.rss / MB), heapUsedMB: round(memory.heapUsed / MB) },
				latencyMs: undefined
			}

			if (!ping) return report

			if (state !== 'open' || !sock.query) {
				report.pingError = state !== 'open' ? 'not connected' : 'ping not available'
				return report
			}

			const started = clock()
			try {
				await sock.query(
					{
						tag: 'iq',
						attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p' },
						content: [{ tag: 'ping', attrs: {} }]
					},
					timeoutMs
				)
				report.latencyMs = Math.round(clock() - started)
			} catch (error) {
				report.pingError = error instanceof Error ? error.message : String(error)
			}

			return report
		}
	}
}

export type Insights = ReturnType<typeof makeInsights>
