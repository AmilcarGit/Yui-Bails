import { Boom } from '@hapi/boom'
import type { ButtonSpec, MiscMessageGenerationOptions, WAMessage } from '../Types'
import type { SenderInfo, SendButtonsOptions } from './helpers'
import type { ButtonReply } from './replies'

type Content = Record<string, unknown>

/** Who may tap a button: the person who asked, group admins, everybody, or your own check */
export type Who = 'sender' | 'admins' | 'anyone' | ((tap: SenderInfo, msg: WAMessage) => boolean | Promise<boolean>)

/** What a handler receives when someone taps one of these buttons */
export type TapContext = {
	/** the message with the tap (reply to it with `sock.reply(msg, ...)`) */
	msg: WAMessage
	reply: ButtonReply
	/** who tapped */
	sender: SenderInfo
}

export type GuardOptions = {
	/** who may tap. Default `'sender'` (only the person who asked) */
	who?: Who
	/** said to someone who may not tap. `false` ignores them silently */
	denied?: string | false
	/** said when the button is too old. `false` ignores the tap silently */
	expired?: string | false
	/** how long the buttons keep working after the last tap, in ms */
	ttlMs?: number
}

export type ConfirmOptions = GuardOptions & {
	yes?: string
	no?: string
	footer?: string
	/** how long to wait for an answer, in ms. Default 30000. When it runs out, `confirm` returns `false` */
	timeoutMs?: number
}

export type PaginateOptions = GuardOptions & {
	/** items per page. Default 5 */
	perPage?: number
	title?: string
	footer?: string
	/** how each item is written. Default `1. item` */
	format?: (item: any, index: number) => string
	prevText?: string
	nextText?: string
	/** said when there is nothing to show */
	empty?: string
}

export type MenuNode = {
	title: string
	description?: string
	/** sub-options: tapping this row opens another menu */
	items?: MenuNode[]
	/** text sent when this row is tapped (or shown above the sub-menu) */
	text?: string
	/** runs when this row is tapped (rows without `items`) */
	run?: (tap: TapContext & { path: string[] }) => void | Promise<void>
}

export type MenuDefinition = GuardOptions & {
	title?: string
	text?: string
	footer?: string
	/** text on the button that opens the list. Default "Ver opciones" */
	buttonText?: string
	/** text of the row that goes back. Default "⬅ Volver" */
	backText?: string
	items: MenuNode[]
}

export type GuardedButtonsOptions = SendButtonsOptions &
	GuardOptions & {
		/** the buttons stop working after the first allowed tap */
		once?: boolean
	}

export type RepeatableOptions = GuardOptions & {
	/** text on the button. Default "🔁 Otra vez" */
	buttonText?: string
	/** how many times it can be repeated. Default 10 */
	maxRepeats?: number
	footer?: string
}

export type InteractiveSocket = {
	sendMessage: (
		jid: string,
		content: any,
		options?: MiscMessageGenerationOptions
	) => Promise<WAMessage | undefined> | WAMessage | undefined
	sendButtons: (
		jid: string,
		options: SendButtonsOptions,
		msgOptions?: MiscMessageGenerationOptions
	) => Promise<WAMessage | undefined> | WAMessage | undefined
	disableButtons: (msg: WAMessage, text?: string) => Promise<boolean>
	getSender: (msg: WAMessage) => Promise<SenderInfo>
	onReply: (
		matcher: (reply: ButtonReply) => boolean,
		run: (msg: WAMessage, reply: ButtonReply) => Promise<void>
	) => unknown
	isAdmin: (groupJid: string, who: SenderInfo) => Promise<boolean>
}

type Session = {
	owner: SenderInfo
	who: Who
	denied: string | false
	expired: string | false
	ttlMs: number
	expiresAt: number
	handle: (tap: TapContext, payload: string) => Promise<void>
}

const PREFIX = 'yui:'
const MAX_SESSIONS = 1000

const DEFAULT_DENIED = '🚫 Este botón no es para ti.'
const DEFAULT_EXPIRED = '⌛ Este botón ya venció. Pide el comando otra vez.'

const sameSender = (a: SenderInfo, b: SenderInfo) =>
	(!!a.pn && a.pn === b.pn) ||
	(!!a.lid && a.lid === b.lid) ||
	(!!a.number && a.number === b.number) ||
	(!!a.id && a.id === b.id)

const chatOf = (msg: Pick<WAMessage, 'key'>) => {
	const jid = msg.key.remoteJid
	if (!jid) throw new Boom('The message has no chat', { statusCode: 400 })
	return jid
}

/**
 * Buttons that think: confirmations, pages, nested menus, buttons only some people can tap and
 * "again" buttons. They are built on quick-reply buttons and dropdown rows, which already work,
 * so there is nothing new for WhatsApp to reject.
 */
export const makeInteractive = (
	sock: InteractiveSocket,
	{ now = Date.now, logger }: { now?: () => number; logger?: { warn: (obj: unknown, msg?: string) => void } } = {}
) => {
	const sessions = new Map<string, Session>()
	let counter = 0

	const quiet = (task: Promise<unknown>) => void task.catch(() => undefined)

	const newSession = (
		owner: SenderInfo,
		options: GuardOptions,
		defaultTtl: number,
		handle: Session['handle']
	): string => {
		if (sessions.size >= MAX_SESSIONS) {
			for (const [token, session] of sessions) {
				if (session.expiresAt < now()) sessions.delete(token)
			}

			if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string)
		}

		counter += 1
		const token = `${now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
		const ttlMs = options.ttlMs ?? defaultTtl
		sessions.set(token, {
			owner,
			who: options.who ?? 'sender',
			denied: options.denied ?? DEFAULT_DENIED,
			expired: options.expired ?? DEFAULT_EXPIRED,
			ttlMs,
			expiresAt: now() + ttlMs,
			handle
		})
		return token
	}

	const isAllowed = async (session: Session, tap: SenderInfo, msg: WAMessage) => {
		const { who } = session
		if (who === 'anyone') return true
		if (typeof who === 'function') return !!(await who(tap, msg))
		if (who === 'admins' && tap.isGroup) return sock.isAdmin(tap.chat, tap)
		return sameSender(session.owner, tap)
	}

	// one handler for every button of every session: the id says which session it belongs to
	void sock.onReply(
		reply => reply.id.startsWith(PREFIX),
		async (msg, reply) => {
			const [, token = '', ...rest] = reply.id.split(':')
			const chat = msg.key.remoteJid
			const say = async (text: string | false) => {
				if (text && chat) await sock.sendMessage(chat, { text }, { quoted: msg })
			}

			const session = sessions.get(token)
			if (!session || session.expiresAt < now()) {
				sessions.delete(token)
				await say(session ? session.expired : DEFAULT_EXPIRED)
				return
			}

			const sender = await sock.getSender(msg)
			if (!(await isAllowed(session, sender, msg))) {
				await say(session.denied)
				return
			}

			session.expiresAt = now() + session.ttlMs

			try {
				await session.handle({ msg, reply, sender }, rest.join(':'))
			} catch (error) {
				logger?.warn({ error }, 'an interactive button handler failed')
			}
		}
	)

	const idFor = (token: string, payload: string | number) => `${PREFIX}${token}:${payload}`

	return {
		/**
		 * Asks yes / no with two buttons and returns `true` or `false`. Only the person who wrote
		 * the command can answer (change it with `who`). `false` also when time runs out.
		 */
		confirm: async (msg: WAMessage, text: string, options: ConfirmOptions = {}): Promise<boolean> => {
			const jid = chatOf(msg)
			const owner = await sock.getSender(msg)
			const yes = options.yes ?? '✅ Sí'
			const no = options.no ?? '❌ No'
			const timeoutMs = options.timeoutMs ?? 30_000

			let sent: WAMessage | undefined
			let done = false
			let finish: (answer: boolean, label: string) => void = () => undefined

			const result = new Promise<boolean>(resolve => {
				let timer: ReturnType<typeof setTimeout> | undefined
				finish = (answer, label) => {
					if (done) return
					done = true
					if (timer) clearTimeout(timer)
					resolve(answer)
					if (sent) quiet(sock.disableButtons(sent, `${text}\n\n${label}`))
				}

				timer = setTimeout(() => {
					sessions.delete(token)
					finish(false, '⌛ Tiempo agotado')
				}, timeoutMs)
			})

			const token = newSession(owner, { ...options, ttlMs: timeoutMs }, timeoutMs, async (_tap, payload) => {
				sessions.delete(token)
				finish(payload === 'y', payload === 'y' ? `› ${yes}` : `› ${no}`)
			})

			try {
				sent = await sock.sendButtons(
					jid,
					{
						text,
						footer: options.footer,
						buttons: [
							{ text: yes, id: idFor(token, 'y') },
							{ text: no, id: idFor(token, 'n') }
						]
					},
					{ quoted: msg }
				)
			} catch (error) {
				sessions.delete(token)
				done = true
				throw error
			}

			return result
		},

		/**
		 * Shows a long list in pages with "Anterior / Siguiente" buttons. Each page is a new message
		 * and the buttons of the previous one are removed. Returns the first page that was sent.
		 */
		paginate: async (msg: WAMessage, items: unknown[], options: PaginateOptions = {}) => {
			const jid = chatOf(msg)

			if (!items.length) {
				return sock.sendMessage(jid, { text: options.empty ?? 'No hay nada que mostrar.' }, { quoted: msg })
			}

			const perPage = Math.max(1, Math.floor(options.perPage ?? 5))
			const pages = Math.ceil(items.length / perPage)
			const owner = await sock.getSender(msg)
			let last: WAMessage | undefined
			let token = ''

			const show = async (page: number, quoted: WAMessage) => {
				const start = page * perPage
				const lines = items
					.slice(start, start + perPage)
					.map((item, index) =>
						options.format ? options.format(item, start + index) : `${start + index + 1}. ${String(item)}`
					)
				const text = `${options.title ? `${options.title}\n\n` : ''}${lines.join('\n')}`

				const buttons: ButtonSpec[] = []
				if (page > 0) buttons.push({ text: options.prevText ?? '◀ Anterior', id: idFor(token, `go:${page - 1}`) })
				if (page < pages - 1)
					buttons.push({ text: options.nextText ?? 'Siguiente ▶', id: idFor(token, `go:${page + 1}`) })

				const footer = `${options.footer ? `${options.footer} · ` : ''}Página ${page + 1} de ${pages}`
				const sent = buttons.length
					? await sock.sendButtons(jid, { text, footer, buttons }, { quoted })
					: await sock.sendMessage(jid, { text, footer }, { quoted })

				if (last) quiet(sock.disableButtons(last))
				last = sent
				return sent
			}

			if (pages > 1) {
				token = newSession(owner, options, 120_000, async (tap, payload) => {
					const page = Number(payload.replace('go:', ''))
					if (Number.isInteger(page) && page >= 0 && page < pages) await show(page, tap.msg)
				})
			}

			try {
				return await show(0, msg)
			} catch (error) {
				sessions.delete(token)
				throw error
			}
		},

		/**
		 * A menu with sub-menus. Every level is a dropdown list; sub-menus get a "Volver" row.
		 * WhatsApp usually allows about 10 rows per list: split bigger ones into sub-menus.
		 */
		menu: async (msg: WAMessage, definition: MenuDefinition) => {
			if (!definition.items?.length) throw new Boom('menu needs at least one item', { statusCode: 400 })

			const jid = chatOf(msg)
			const owner = await sock.getSender(msg)
			const root: MenuNode = { title: definition.title ?? 'Menú', text: definition.text, items: definition.items }

			const nodeAt = (path: string): MenuNode | undefined => {
				let node: MenuNode | undefined = root
				for (const part of path ? path.split('.') : []) {
					node = node?.items?.[Number(part)]
				}

				return node
			}

			let token = ''

			const showLevel = async (path: string, quoted: WAMessage) => {
				const node = nodeAt(path)
				if (!node?.items?.length) return undefined

				const rows = node.items.map((child, index) => ({
					title: child.title,
					description: child.description,
					id: idFor(token, path ? `${path}.${index}` : String(index))
				}))

				if (path) {
					const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : ''
					rows.push({
						title: definition.backText ?? '⬅ Volver',
						description: undefined,
						id: idFor(token, `b${parent}`)
					})
				}

				return sock.sendButtons(
					jid,
					{
						title: definition.title,
						text: node.text ?? definition.text ?? node.title,
						footer: definition.footer,
						buttons: [{ text: definition.buttonText ?? 'Ver opciones', sections: [{ title: node.title, rows }] }]
					} as SendButtonsOptions,
					{ quoted }
				)
			}

			token = newSession(owner, definition, 10 * 60_000, async (tap, payload) => {
				if (payload.startsWith('b')) {
					await showLevel(payload.slice(1), tap.msg)
					return
				}

				const node = nodeAt(payload)
				if (!node) return

				if (node.items?.length) {
					await showLevel(payload, tap.msg)
					return
				}

				if (node.text) await sock.sendMessage(chatOf(tap.msg), { text: node.text }, { quoted: tap.msg })

				const titles: string[] = []
				let walk: MenuNode | undefined = root
				for (const part of payload.split('.')) {
					walk = walk?.items?.[Number(part)]
					if (walk) titles.push(walk.title)
				}

				await node.run?.({ ...tap, path: titles })
			})

			try {
				return await showLevel('', msg)
			} catch (error) {
				sessions.delete(token)
				throw error
			}
		},

		/**
		 * `sendButtons` where only some people can tap. Others get a short "this is not for you".
		 * Quick-reply buttons and dropdown rows are guarded; URL / call / copy buttons act by themselves.
		 */
		sendGuardedButtons: async (
			msg: WAMessage,
			options: GuardedButtonsOptions,
			onTap: (tap: TapContext & { id: string }) => void | Promise<void>
		) => {
			const jid = chatOf(msg)
			const owner = await sock.getSender(msg)
			const originals = new Map<string, string>()
			let last: WAMessage | undefined

			const token = newSession(owner, options, 10 * 60_000, async (tap, payload) => {
				const id = originals.get(payload)
				if (id === undefined) return

				if (options.once) {
					sessions.delete(token)
					if (last) quiet(sock.disableButtons(last))
				}

				await onTap({ ...tap, id })
			})

			const guard = (id: string) => {
				const key = String(originals.size)
				originals.set(key, id)
				return idFor(token, key)
			}

			const rest: Record<string, unknown> = { ...options }
			for (const key of ['once', 'who', 'denied', 'expired', 'ttlMs']) delete rest[key]
			const buttons = options.buttons.map(button => {
				const spec = { ...(button as Record<string, unknown>) }
				if (typeof spec.id === 'string') spec.id = guard(spec.id)

				if (Array.isArray(spec.sections)) {
					spec.sections = spec.sections.map((section: { rows?: Array<Record<string, unknown>> }) => ({
						...section,
						rows: section.rows?.map(row => {
							const original = row.id ?? row.rowId
							return typeof original === 'string' ? { ...row, id: guard(original) } : row
						})
					}))
				}

				return spec as ButtonSpec
			})

			try {
				last = await sock.sendButtons(jid, { ...rest, buttons } as SendButtonsOptions, { quoted: msg })
				return last
			} catch (error) {
				sessions.delete(token)
				throw error
			}
		},

		/**
		 * Sends something with a "🔁 Otra vez" button. Each tap sends it again (a function gives a new
		 * result every time, e.g. a random phrase) and removes the button from the older message.
		 */
		sendRepeatable: async (
			msg: WAMessage,
			source: string | Content | (() => string | Content | Promise<string | Content>),
			options: RepeatableOptions = {}
		) => {
			const jid = chatOf(msg)
			const owner = await sock.getSender(msg)
			const max = options.maxRepeats ?? 10
			let repeats = 0
			let last: WAMessage | undefined
			let token = ''

			const sendOne = async (quoted: WAMessage) => {
				const raw = typeof source === 'function' ? await source() : source
				const content: Content = typeof raw === 'string' ? { text: raw } : { ...raw }
				const footer = (content.footer as string | undefined) ?? options.footer

				const sent =
					repeats < max
						? await sock.sendButtons(
								jid,
								{
									...content,
									footer,
									buttons: [{ text: options.buttonText ?? '🔁 Otra vez', id: idFor(token, 'again') }]
								} as SendButtonsOptions,
								{ quoted }
							)
						: await sock.sendMessage(jid, { ...content, footer }, { quoted })

				if (last) quiet(sock.disableButtons(last))
				last = sent
				return sent
			}

			token = newSession(owner, { who: 'anyone', ...options }, 10 * 60_000, async tap => {
				repeats += 1
				await sendOne(tap.msg)
			})

			try {
				return await sendOne(msg)
			} catch (error) {
				sessions.delete(token)
				throw error
			}
		}
	}
}

export type Interactive = ReturnType<typeof makeInteractive>
