import type { WAMessage } from '../Types'
import type { SenderInfo } from './helpers'
import { normalizeMessageContent } from './messages'

/** What the user tapped on a button, list or menu message */
export type ButtonReply = {
	/** `button`: quick reply / classic button · `list`: row of a list · `template`: template button */
	type: 'button' | 'list' | 'template'
	/** the id you gave the button or row */
	id: string
	/** the text shown on it, when WhatsApp sends it */
	text: string | undefined
	/** id of the message that carried the button (to tell several menus apart) */
	quotedId: string | undefined
}

/**
 * Reads a button / list / menu tap from a message, whatever format WhatsApp used.
 * Returns `undefined` when the message is not a tap.
 */
export const getReply = (msg: Pick<WAMessage, 'message'>): ButtonReply | undefined => {
	const content = normalizeMessageContent(msg.message)
	if (!content) return undefined

	if (content.buttonsResponseMessage) {
		const r = content.buttonsResponseMessage
		return {
			type: 'button',
			id: r.selectedButtonId || '',
			text: r.selectedDisplayText || undefined,
			quotedId: r.contextInfo?.stanzaId || undefined
		}
	}

	if (content.listResponseMessage) {
		const r = content.listResponseMessage
		return {
			type: 'list',
			id: r.singleSelectReply?.selectedRowId || '',
			text: r.title || undefined,
			quotedId: r.contextInfo?.stanzaId || undefined
		}
	}

	if (content.templateButtonReplyMessage) {
		const r = content.templateButtonReplyMessage
		return {
			type: 'template',
			id: r.selectedId || '',
			text: r.selectedDisplayText || undefined,
			quotedId: r.contextInfo?.stanzaId || undefined
		}
	}

	const native = content.interactiveResponseMessage?.nativeFlowResponseMessage
	if (native) {
		let params: Record<string, unknown> = {}
		try {
			params = JSON.parse(native.paramsJson || '{}')
		} catch {
			// a malformed payload still counts as a tap, just without an id
		}

		const id = params.id ?? params.row_id ?? params.selectedRowId
		return {
			type: native.name === 'single_select' ? 'list' : 'button',
			id: typeof id === 'string' ? id : '',
			text:
				(typeof params.title === 'string' && params.title) ||
				(typeof params.display_text === 'string' && params.display_text) ||
				content.interactiveResponseMessage?.body?.text ||
				undefined,
			quotedId: content.interactiveResponseMessage?.contextInfo?.stanzaId || undefined
		}
	}

	return undefined
}

export type ReplyMatcher = string | RegExp | ((reply: ButtonReply) => boolean)
export type ReplyHandler = (msg: WAMessage, reply: ButtonReply) => void | Promise<void>

export type OnReplyOptions = {
	/** only the first tap on each menu message is handled; later taps call `onUsed` instead */
	once?: boolean
	/** called when a menu that was already used is tapped again (needs `once`) */
	onUsed?: ReplyHandler
}

export type AwaitReplyOptions = {
	/** how long to wait, in ms. Default 60000 */
	timeoutMs?: number
	/** only accept messages that pass this test */
	filter?: (msg: WAMessage) => boolean
}

/** What `makeReplyTools` needs from the socket (a subset, so it is easy to test) */
export type ReplySocket = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ev: { on: (event: any, listener: (...args: any[]) => void) => void }
	getSender: (msg: WAMessage) => Promise<SenderInfo>
}

const matches = (matcher: ReplyMatcher, reply: ButtonReply) =>
	typeof matcher === 'string'
		? reply.id === matcher
		: matcher instanceof RegExp
			? matcher.test(reply.id)
			: matcher(reply)

const MAX_USED = 2000

/**
 * Easy handling of what users answer: `onButton`, `onList`, `onReply` run a function when a
 * button or row with a given id is tapped; `awaitReply` waits for the next message of a user.
 */
export const makeReplyTools = (sock: ReplySocket, logger?: { warn: (...args: any[]) => void }) => {
	type Handler = { matcher: ReplyMatcher; types: ButtonReply['type'][]; run: ReplyHandler; options: OnReplyOptions }
	type Waiter = {
		chat: string
		sender: SenderInfo
		filter?: (msg: WAMessage) => boolean
		resolve: (msg: WAMessage | undefined) => void
		timer: ReturnType<typeof setTimeout>
	}

	const handlers = new Set<Handler>()
	const waiters = new Set<Waiter>()
	const used = new Set<string>()

	const same = (a: SenderInfo, b: SenderInfo) => (!!a.pn && a.pn === b.pn) || (!!a.lid && a.lid === b.lid)

	const markUsed = (quotedId: string) => {
		used.add(quotedId)
		if (used.size > MAX_USED) used.delete(used.values().next().value as string)
	}

	sock.ev.on('messages.upsert', async ({ messages, type }: { messages: WAMessage[]; type: string }) => {
		if (type !== 'notify') return

		for (const msg of messages) {
			if (msg.key.fromMe || !msg.message) continue

			try {
				// 1) someone is waiting for this user's next message
				for (const waiter of [...waiters]) {
					if (waiter.chat !== msg.key.remoteJid || waiter.filter?.(msg) === false) continue
					if (!same(waiter.sender, await sock.getSender(msg))) continue

					clearTimeout(waiter.timer)
					waiters.delete(waiter)
					waiter.resolve(msg)
				}

				// 2) button / list handlers
				const reply = getReply(msg)
				if (!reply) continue

				for (const handler of [...handlers]) {
					if (!handler.types.includes(reply.type) || !matches(handler.matcher, reply)) continue

					if (handler.options.once && reply.quotedId) {
						if (used.has(reply.quotedId)) {
							await handler.options.onUsed?.(msg, reply)
							continue
						}

						markUsed(reply.quotedId)
					}

					await handler.run(msg, reply)
				}
			} catch (error) {
				logger?.warn({ error }, 'a reply handler failed')
			}
		}
	})

	const register =
		(types: ButtonReply['type'][]) =>
		(matcher: ReplyMatcher, run: ReplyHandler, options: OnReplyOptions = {}) => {
			const handler: Handler = { matcher, types, run, options }
			handlers.add(handler)
			return () => handlers.delete(handler)
		}

	return {
		/** Runs `run` when a button, list row or template button with that id is tapped. Returns a function that removes it. */
		onReply: register(['button', 'list', 'template']),
		/** Same, only for buttons (quick replies). */
		onButton: register(['button', 'template']),
		/** Same, only for rows of a list / dropdown menu. */
		onList: register(['list']),

		/**
		 * Waits for the next message that the same person sends in the same chat as `msg`.
		 * Resolves `undefined` when the time runs out.
		 */
		awaitReply: async (msg: WAMessage, { timeoutMs = 60_000, filter }: AwaitReplyOptions = {}) => {
			const sender = await sock.getSender(msg)
			return new Promise<WAMessage | undefined>(resolve => {
				const waiter: Waiter = {
					chat: msg.key.remoteJid || '',
					sender,
					filter,
					resolve,
					timer: setTimeout(() => {
						waiters.delete(waiter)
						resolve(undefined)
					}, timeoutMs)
				}
				waiters.add(waiter)
			})
		}
	}
}

export type ReplyTools = ReturnType<typeof makeReplyTools>
