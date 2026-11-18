import { DisconnectReason } from '../Types'

export type GiveUpReason = 'logged-out' | 'replaced' | 'bad-session' | 'forbidden' | 'too-many-attempts'

export type ReconnectOptions = {
	/** creates the new socket (the same function that started the bot) */
	connect: () => unknown
	/** failed attempts in a row before giving up. Default 10 */
	maxRetries?: number
	/** wait before the first retry, doubled each time. Default 2000 ms */
	baseDelayMs?: number
	/** longest wait. Default 60000 ms */
	maxDelayMs?: number
	/** random extra wait, as a share of the wait (0 to 1), so many bots do not come back at the same second. Default 0.2 */
	jitter?: number
	/** a connection that stays open this long counts as healthy and resets the attempts. Default 30000 ms */
	stableAfterMs?: number
	/** called before each wait */
	onRetry?: (info: { attempt: number; delayMs: number; statusCode?: number }) => void
	/** called when retrying would not help (the account was logged out, the session was replaced…) */
	onGiveUp?: (reason: GiveUpReason, statusCode?: number) => void
	/** replaceable in tests */
	sleep?: (ms: number) => Promise<void>
	random?: () => number
	now?: () => number
}

export type ConnectionUpdateLike = {
	connection?: string
	lastDisconnect?: { error?: unknown }
}

const statusOf = (error: unknown) => (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode

const FINAL: Record<number, GiveUpReason> = {
	[DisconnectReason.loggedOut]: 'logged-out',
	[DisconnectReason.connectionReplaced]: 'replaced',
	[DisconnectReason.badSession]: 'bad-session',
	[DisconnectReason.forbidden]: 'forbidden'
}

/**
 * Reconnects after a drop with growing waits. Feed it the `connection.update` events:
 *
 *   const reconnector = makeReconnector({ connect: startBot })
 *   sock.ev.on('connection.update', update => reconnector.handle(update))
 *
 * It does not retry when retrying is useless or harmful: a logged-out account, a session replaced by
 * another device (retrying would make the two fight), a bad session or a forbidden one. The restart
 * WhatsApp asks for right after pairing (515) is done at once and does not count as a failure.
 */
export const makeReconnector = ({
	connect,
	maxRetries = 10,
	baseDelayMs = 2000,
	maxDelayMs = 60_000,
	jitter = 0.2,
	stableAfterMs = 30_000,
	onRetry,
	onGiveUp,
	sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
	random = Math.random,
	now = Date.now
}: ReconnectOptions) => {
	let attempts = 0
	let openedAt: number | undefined
	let waiting = false
	let stopped = false

	const retry = async (delayMs: number, statusCode: number | undefined, counted: boolean) => {
		if (counted) attempts++
		waiting = true
		onRetry?.({ attempt: attempts, delayMs, statusCode })
		await sleep(delayMs)
		waiting = false
		if (stopped) return

		try {
			await connect()
		} catch {
			// the new socket could not even be created: it counts like any other failure
			await closed(undefined)
		}
	}

	const closed = async (statusCode: number | undefined) => {
		if (stopped || waiting) return

		if (openedAt !== undefined && now() - openedAt >= stableAfterMs) attempts = 0
		openedAt = undefined

		const final = statusCode === undefined ? undefined : FINAL[statusCode]
		if (final) {
			onGiveUp?.(final, statusCode)
			return
		}

		if (statusCode === DisconnectReason.restartRequired) {
			await retry(0, statusCode, false)
			return
		}

		if (attempts >= maxRetries) {
			onGiveUp?.('too-many-attempts', statusCode)
			return
		}

		const base = Math.min(maxDelayMs, baseDelayMs * 2 ** attempts)
		const delayMs = Math.min(maxDelayMs, Math.round(base + base * jitter * random()))
		await retry(delayMs, statusCode, true)
	}

	return {
		/** pass every `connection.update`; resolves when the reconnection it caused is done (never rejects) */
		handle: async (update: ConnectionUpdateLike): Promise<void> => {
			if (update.connection === 'open') {
				openedAt = now()
			} else if (update.connection === 'close') {
				await closed(statusOf(update.lastDisconnect?.error))
			}
		},
		/** stops reconnecting (call it when you shut the bot down on purpose) */
		stop: () => {
			stopped = true
		},
		/** failed attempts in a row */
		attempts: () => attempts
	}
}

export type Reconnector = ReturnType<typeof makeReconnector>
