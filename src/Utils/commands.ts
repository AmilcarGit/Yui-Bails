import { Boom } from '@hapi/boom'
import type { MiscMessageGenerationOptions, WAMessage } from '../Types'
import { type Cooldowns, makeCooldowns } from './cooldown'
import type { SenderInfo } from './helpers'
import { extractMessageContent } from './messages'

type Content = Record<string, unknown>

/** who may run a command: everybody, the group admins (and owners), or only the owners */
export type CommandRole = 'all' | 'admin' | 'owner'

export type CommandContext = {
	msg: WAMessage
	/** canonical name of the command (aliases resolve to it) */
	command: string
	/** the prefix that was used (`''` when the router has no prefix) */
	prefix: string
	/** everything after the command, as written */
	text: string
	/** `text` split by spaces */
	args: string[]
	sender: SenderInfo
	chat: string
	isGroup: boolean
	/** quoted answer to the command */
	reply: (content: string | Content, options?: MiscMessageGenerationOptions) => Promise<unknown>
}

export type CommandDefinition = {
	name: string
	aliases?: string[]
	description?: string
	/** free text to group commands in a menu */
	category?: string
	/** default `'all'` */
	role?: CommandRole
	/** per-user wait between two uses of this command, in ms. Default 0 */
	cooldownMs?: number
	groupOnly?: boolean
	privateOnly?: boolean
	run: (ctx: CommandContext) => void | Promise<void>
}

export type CommandMessages = {
	owner?: string
	admin?: string
	groupOnly?: string
	privateOnly?: string
	cooldown?: (secondsLeft: number) => string
	spam?: string
}

export type CommandsOptions = {
	/** one or several prefixes. Default `['.', '!', '/', '#']`. `false` = commands without prefix */
	prefix?: string | string[] | false
	/** numbers (or ids / jids) that are owners */
	owners?: string[]
	/** the number linked to the bot counts as an owner. Default true */
	ownerIncludesBot?: boolean
	/** too many commands in a short time from one user: the rest are ignored. `false` turns it off. Default 6 per 10 s */
	spam?: { max: number; windowMs: number } | false
	messages?: CommandMessages
	/** a command threw: default tells the chat and logs it */
	onError?: (error: unknown, ctx: CommandContext) => void | Promise<void>
	now?: () => number
}

export type CommandsSocket = {
	ev: {
		on: (event: string, handler: (data: any) => void) => void
		off?: (event: string, handler: (data: any) => void) => void
	}
	getSender: (msg: WAMessage) => Promise<SenderInfo>
	sendMessage: (jid: string, content: any, options?: MiscMessageGenerationOptions) => Promise<unknown> | unknown
	isAdmin: (groupJid: string, who: SenderInfo) => Promise<boolean>
}

const DEFAULT_MESSAGES: Required<CommandMessages> = {
	owner: '🔒 Este comando es solo para el dueño del bot.',
	admin: '🔒 Este comando es solo para admins del grupo.',
	groupOnly: '👥 Este comando solo funciona en grupos.',
	privateOnly: '👤 Este comando solo funciona en chats privados.',
	cooldown: seconds => `⏳ Espera ${seconds} s para volver a usar este comando.`,
	spam: '🚦 Vas muy rápido. Espera unos segundos.'
}

const textOf = (msg: WAMessage): string => {
	const content = extractMessageContent(msg.message)
	if (!content) return ''
	return (
		content.conversation ||
		content.extendedTextMessage?.text ||
		content.imageMessage?.caption ||
		content.videoMessage?.caption ||
		content.documentMessage?.caption ||
		''
	)
}

/**
 * A small command router: prefixes, aliases, roles (owner / admin), group or private only,
 * a cooldown per user and a basic anti-spam. It does not replace your own handler: use it
 * (`listen()`) or call `handle(msg)` yourself.
 */
export const makeCommands = (sock: CommandsSocket, options: CommandsOptions = {}) => {
	const now = options.now || Date.now
	const prefixes = options.prefix === false ? [''] : [options.prefix ?? ['.', '!', '/', '#']].flat()
	const messages = { ...DEFAULT_MESSAGES, ...options.messages }
	const owners = options.owners || []
	const ownerIncludesBot = options.ownerIncludesBot ?? true
	const spamRule = options.spam === undefined ? { max: 6, windowMs: 10_000 } : options.spam

	const cooldowns: Cooldowns = makeCooldowns({ now })
	const registry = new Map<string, CommandDefinition>()
	const byName = new Map<string, CommandDefinition>()
	const recent = new Map<string, number[]>()
	const warned = new Map<string, number>()

	const say = async (chat: string, msg: WAMessage, text: string) => {
		await sock.sendMessage(chat, { text }, { quoted: msg })
	}

	const isOwner = (sender: SenderInfo) =>
		(ownerIncludesBot && sender.fromMe) || (owners.length > 0 && sender.is(owners))

	/** true when this user is sending too many commands */
	const isSpamming = (user: string): boolean => {
		if (!spamRule) return false

		const stamps = (recent.get(user) || []).filter(at => now() - at < spamRule.windowMs)
		stamps.push(now())
		recent.set(user, stamps)
		return stamps.length > spamRule.max
	}

	const manager = {
		/** registers a command (its name and aliases must be free) */
		add: (definition: CommandDefinition) => {
			const name = definition.name.toLowerCase()
			if (!name || /\s/.test(name)) throw new Boom(`Invalid command name "${definition.name}"`, { statusCode: 400 })

			const names = [name, ...(definition.aliases || []).map(alias => alias.toLowerCase())]
			for (const candidate of names) {
				if (byName.has(candidate))
					throw new Boom(`The command or alias "${candidate}" already exists`, { statusCode: 400 })
			}

			registry.set(name, definition)
			for (const candidate of names) byName.set(candidate, definition)
			return manager
		},

		remove: (name: string) => {
			const definition = byName.get(name.toLowerCase())
			if (!definition) return false

			registry.delete(definition.name.toLowerCase())
			for (const [key, value] of [...byName]) if (value === definition) byName.delete(key)
			return true
		},

		get: (name: string) => byName.get(name.toLowerCase()),

		/** every command, for a help menu */
		list: (): CommandDefinition[] => [...registry.values()],

		/** the per-user cooldowns (also useful outside commands) */
		cooldowns,

		/**
		 * Runs the command written in `msg`, if there is one. Returns `true` when the message was a
		 * known command (even if it was denied), `false` when it is not for the router.
		 */
		handle: async (msg: WAMessage): Promise<boolean> => {
			const chat = msg.key.remoteJid
			if (!chat) return false

			const text = textOf(msg).trim()
			const prefix = prefixes.find(candidate => text.startsWith(candidate))
			if (prefix === undefined) return false

			const [word = '', ...args] = text.slice(prefix.length).split(/\s+/)
			const definition = byName.get(word.toLowerCase())
			if (!definition) return false

			const sender = await sock.getSender(msg)
			const isGroup = sender.isGroup
			const user = sender.number || sender.id || sender.jid
			const ctx: CommandContext = {
				msg,
				command: definition.name.toLowerCase(),
				prefix,
				text: text.slice(prefix.length + word.length).trim(),
				args: args.filter(Boolean),
				sender,
				chat,
				isGroup,
				reply: (content, replyOptions) =>
					Promise.resolve(
						sock.sendMessage(chat, typeof content === 'string' ? { text: content } : content, {
							quoted: msg,
							...replyOptions
						})
					)
			}

			if (!isOwner(sender) && isSpamming(user)) {
				// one notice per window, not one per message
				if (now() - (warned.get(user) ?? 0) > (spamRule ? spamRule.windowMs : 0)) {
					warned.set(user, now())
					await say(chat, msg, messages.spam)
				}

				return true
			}

			if (definition.groupOnly && !isGroup) {
				await say(chat, msg, messages.groupOnly)
				return true
			}

			if (definition.privateOnly && isGroup) {
				await say(chat, msg, messages.privateOnly)
				return true
			}

			const owner = isOwner(sender)
			const role = definition.role ?? 'all'
			if (role === 'owner' && !owner) {
				await say(chat, msg, messages.owner)
				return true
			}

			if (role === 'admin' && !owner && !(isGroup && (await sock.isAdmin(chat, sender)))) {
				await say(chat, msg, messages.admin)
				return true
			}

			// owners are never made to wait
			const left = owner ? 0 : cooldowns.use(user, ctx.command, definition.cooldownMs ?? 0)
			if (left > 0) {
				await say(chat, msg, messages.cooldown(Math.ceil(left / 1000)))
				return true
			}

			try {
				await definition.run(ctx)
			} catch (error) {
				if (options.onError) await options.onError(error, ctx)
				else await say(chat, msg, '⚠️ Algo salió mal con ese comando.').catch(() => undefined)
			}

			return true
		},

		/** starts listening to new messages. Returns a function that stops it. */
		listen: () => {
			// `notify` = something a person just wrote. The bot's own sends arrive as `append`.
			const handler = ({ messages, type }: { messages: WAMessage[]; type: string }) => {
				if (type !== 'notify') return
				for (const msg of messages) void manager.handle(msg).catch(() => undefined)
			}

			sock.ev.on('messages.upsert', handler)
			return () => sock.ev.off?.('messages.upsert', handler)
		}
	}

	return manager
}

export type Commands = ReturnType<typeof makeCommands>
