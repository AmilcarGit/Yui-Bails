import { generateMessageIDV2 } from './generics'
import { isTransient } from './group-fetch'

export type SendRetryOptions = {
	/** extra tries after the first one. Default 2 */
	retries?: number
	/** first wait in ms, doubled each retry. Default 1500 */
	baseDelayMs?: number
	/** our own user id, used to make the message id */
	userId?: () => string | undefined
	/** replaceable for tests */
	sleep?: (ms: number) => Promise<void>
	onRetry?: (error: unknown, attempt: number) => void
}

type SendFn = (jid: string, content: any, options?: any) => Promise<any>

/**
 * Retries a send that failed for a reason that usually passes (rate limit, timeout, empty answer).
 *
 * Every try uses the SAME message id, so if the first try actually reached WhatsApp and only its
 * answer was lost, the retry is recognised as the same message and does not arrive twice.
 */
export const withSendRetry = <F extends SendFn>(
	send: F,
	{ retries = 2, baseDelayMs = 1500, userId, sleep, onRetry }: SendRetryOptions = {}
): F => {
	const wait = sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

	const retrying = async (jid: string, content: any, options: any = {}) => {
		const messageId = options.messageId || generateMessageIDV2(userId?.())
		const tryOptions = { ...options, messageId }

		for (let attempt = 0; ; attempt++) {
			try {
				return await send(jid, content, tryOptions)
			} catch (error) {
				if (attempt >= retries || !isTransient(error)) throw error
				onRetry?.(error, attempt + 1)
				await wait(baseDelayMs * 2 ** attempt)
			}
		}
	}

	return retrying as F
}
