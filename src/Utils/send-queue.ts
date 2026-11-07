import { Boom } from '@hapi/boom'
import type { MiscMessageGenerationOptions, WAMessage } from '../Types'

export type SendQueueOptions = {
	/** random pause between two consecutive sends, in ms. Default 800–2500 */
	minDelayMs?: number
	maxDelayMs?: number
	/** minimum time between two messages to the same chat, in ms. Default 1500 */
	perChatIntervalMs?: number
	/** at most `max` messages per chat in `windowMs`; extra messages wait. Default 20 per minute */
	perChatLimit?: { max: number; windowMs: number }
	/** show "typing…" before text messages. Default true */
	typing?: boolean
	/** typing time per character in ms (clamped to typingMinMs–typingMaxMs). Default 30 */
	typingMsPerChar?: number
	typingMinMs?: number
	typingMaxMs?: number
	/** messages waiting in the queue before `sendMessage` starts to fail. Default 500 */
	maxQueueSize?: number
	/** randomness, clock and sleeping, replaceable for tests */
	random?: () => number
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}

type SendFn = (jid: string, content: any, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>

export type QueueSocket = {
	sendMessage: SendFn
	sendPresenceUpdate?: (type: 'composing' | 'paused', toJid?: string) => Promise<void>
}

type Job = {
	jid: string
	content: any
	options?: MiscMessageGenerationOptions
	resolve: (value: WAMessage | undefined) => void
	reject: (reason: unknown) => void
}

const DEFAULTS = {
	minDelayMs: 800,
	maxDelayMs: 2500,
	perChatIntervalMs: 1500,
	perChatLimit: { max: 20, windowMs: 60_000 },
	typing: true,
	typingMsPerChar: 30,
	typingMinMs: 500,
	typingMaxMs: 3000,
	maxQueueSize: 500
}

/** actions that are not "writing a message": they skip the typing indicator */
const NO_TYPING = ['react', 'delete', 'edit', 'disappearingMessagesInChat', 'pin', 'poll', 'forward']

const textOf = (content: any): string => {
	if (!content || typeof content !== 'object') return ''
	for (const field of ['text', 'caption']) {
		if (typeof content[field] === 'string') return content[field]
	}

	return ''
}

/**
 * Wraps `sock.sendMessage` so messages leave one by one, with human-like pauses, a per-chat
 * rate limit and an automatic "typing…" indicator. Everything that gets sent through
 * `sock.sendMessage` (including `reply`, `sendButtons`…) is queued; `sock.sendMessageNow` skips it.
 */
export const makeSendQueue = (sock: QueueSocket, options: SendQueueOptions = {}) => {
	const cfg = { ...DEFAULTS, ...options, perChatLimit: { ...DEFAULTS.perChatLimit, ...options.perChatLimit } }
	const random = options.random || Math.random
	const now = options.now || Date.now
	const sleep = options.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

	const sendNow: SendFn = sock.sendMessage.bind(sock)
	const jobs: Job[] = []
	const history = new Map<string, number[]>()
	let running = false
	let lastSendAt = 0

	const between = (min: number, max: number) => Math.round(min + random() * Math.max(0, max - min))

	/** how long this chat must still wait before it can receive another message */
	const chatWait = (jid: string) => {
		const stamps = (history.get(jid) || []).filter(at => now() - at < cfg.perChatLimit.windowMs)
		history.set(jid, stamps)

		let wait = 0
		const last = stamps[stamps.length - 1]
		if (last !== undefined) wait = Math.max(wait, cfg.perChatIntervalMs - (now() - last))

		if (stamps.length >= cfg.perChatLimit.max) {
			const oldest = stamps[stamps.length - cfg.perChatLimit.max]!
			wait = Math.max(wait, cfg.perChatLimit.windowMs - (now() - oldest))
		}

		return Math.max(0, wait)
	}

	const typingFor = async (job: Job) => {
		const text = textOf(job.content)
		const isChat = !job.jid.endsWith('@broadcast') && !job.jid.endsWith('@newsletter')
		const skip = Object.keys(job.content || {}).some(field => NO_TYPING.includes(field))
		if (!cfg.typing || !text || !isChat || skip || !sock.sendPresenceUpdate) return

		const duration = Math.min(cfg.typingMaxMs, Math.max(cfg.typingMinMs, text.length * cfg.typingMsPerChar))
		try {
			await sock.sendPresenceUpdate('composing', job.jid)
			await sleep(duration)
			await sock.sendPresenceUpdate('paused', job.jid)
		} catch {
			// the typing indicator is cosmetic: never fail a message because of it
		}
	}

	const run = async () => {
		if (running) return
		running = true

		try {
			for (let job = jobs.shift(); job; job = jobs.shift()) {
				try {
					const pause = Math.max(between(cfg.minDelayMs, cfg.maxDelayMs) - (now() - lastSendAt), chatWait(job.jid))
					if (lastSendAt && pause > 0) await sleep(pause)

					await typingFor(job)
					const result = await sendNow(job.jid, job.content, job.options)

					lastSendAt = now()
					history.set(job.jid, [...(history.get(job.jid) || []), lastSendAt])
					job.resolve(result)
				} catch (error) {
					lastSendAt = now()
					job.reject(error)
				}
			}
		} finally {
			running = false
		}
	}

	const enqueue: SendFn = (jid, content, sendOptions) =>
		new Promise((resolve, reject) => {
			if (jobs.length >= cfg.maxQueueSize) {
				reject(new Boom('The send queue is full', { statusCode: 429 }))
				return
			}

			jobs.push({ jid, content, options: sendOptions, resolve, reject })
			void run()
		})

	return {
		/** queued, rate-limited replacement for `sock.sendMessage` */
		sendMessage: enqueue,
		/** the original `sendMessage`, with no queue */
		sendMessageNow: sendNow,
		queue: {
			/** messages waiting to be sent */
			get size() {
				return jobs.length
			},
			/** drops everything that is still waiting; those `sendMessage` calls reject */
			clear: () => {
				const dropped = jobs.splice(0, jobs.length)
				for (const job of dropped) job.reject(new Boom('The send queue was cleared', { statusCode: 499 }))
				return dropped.length
			}
		}
	}
}

export type SendQueue = ReturnType<typeof makeSendQueue>
