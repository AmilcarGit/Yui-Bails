import { Boom } from '@hapi/boom'
import type {
	ButtonSpec,
	MiscMessageGenerationOptions,
	PollMessageOptions,
	WAMessage,
	WAMessageKey,
	WAMessageUpdate
} from '../Types'
import { isJidGroup, isLidUser, isPnUser, jidDecode, jidNormalizedUser } from '../WABinary'
import { downloadMediaMessage, getAggregateVotesInPollMessage } from './messages'

/** Who wrote a message, with both of WhatsApp's identities resolved when possible */
export type SenderInfo = {
	/** chat the message belongs to (group, private chat…) */
	chat: string
	isGroup: boolean
	fromMe: boolean
	/** best jid to talk to the sender: the phone-number jid when known, otherwise the LID */
	jid: string
	/** phone-number jid (`5191…@s.whatsapp.net`) when known */
	pn: string | undefined
	/** LID jid (`2696…@lid`) when known */
	lid: string | undefined
	/** phone number, digits only (`undefined` when only the LID is known) */
	number: string | undefined
	/** WhatsApp's internal id: the user part of the LID (`undefined` when it is not known) */
	id: string | undefined
	/** true when the number or the internal id is in `list` (numbers, ids or full jids) */
	is: (list: string | string[]) => boolean
}

type Me = { id?: string; lid?: string } | undefined

const userPart = (jid: string | undefined) => (jid ? jidDecode(jid)?.user : undefined)

const clean = (value: string) => {
	const digits = value.replace(/\D/g, '')
	return digits || value.split('@')[0]!.split(':')[0]!
}

/**
 * Reads who sent a message using only the message itself (no network, no lookups).
 * Use `sock.getSender(msg)` to also resolve the missing identity through WhatsApp's LID mapping.
 */
export const getSenderIds = (msg: Pick<WAMessage, 'key' | 'participant'>, me?: Me): SenderInfo => {
	const key: WAMessageKey = msg.key
	const chat = key.remoteJid || ''
	const isGroup = !!isJidGroup(chat) || chat === 'status@broadcast'
	const fromMe = !!key.fromMe

	let pn: string | undefined
	let lid: string | undefined

	if (fromMe && me) {
		pn = me.id ? jidNormalizedUser(me.id) : undefined
		lid = me.lid ? jidNormalizedUser(me.lid) : undefined
	} else {
		const main = isGroup ? key.participant || msg.participant : key.remoteJid
		const alt = isGroup ? key.participantAlt : key.remoteJidAlt
		for (const candidate of [main, alt]) {
			if (!candidate) continue
			const normalized = jidNormalizedUser(candidate)
			if (!pn && isPnUser(normalized)) pn = normalized
			else if (!lid && isLidUser(normalized)) lid = normalized
		}
	}

	return buildSender({ chat, isGroup, fromMe, pn, lid })
}

const buildSender = ({
	chat,
	isGroup,
	fromMe,
	pn,
	lid
}: {
	chat: string
	isGroup: boolean
	fromMe: boolean
	pn: string | undefined
	lid: string | undefined
}): SenderInfo => {
	const number = userPart(pn)
	const id = userPart(lid)
	const known = [number, id].filter((value): value is string => !!value)

	return {
		chat,
		isGroup,
		fromMe,
		jid: pn || lid || '',
		pn,
		lid,
		number,
		id,
		is: list => (Array.isArray(list) ? list : [list]).map(clean).some(entry => known.includes(entry))
	}
}

export type SendButtonsOptions = {
	text?: string
	footer?: string
	title?: string
	buttons: ButtonSpec[]
	/** classic buttons render in every client; `interactive` (default) uses native flow */
	buttonsFormat?: 'interactive' | 'buttons'
}

export type SendListOptions = {
	text?: string
	title?: string
	footer?: string
	/** label of the button that opens the list */
	buttonText?: string
	/** simple form: `{ title, rows: [{ id, title, description? }] }` */
	sections: { title?: string; rows: { id?: string; rowId?: string; title: string; description?: string }[] }[]
}

export type DownloadMediaOptions = {
	/** download the media of the message this one replies to */
	quoted?: boolean
}

export type PollVotes = {
	/** key of the poll message */
	pollKey: WAMessageKey
	pollName: string
	/** every option with the people who chose it (the voters of an option can be empty) */
	votes: { name: string; voters: string[] }[]
	/** the voter that triggered this update */
	voter: string
}

type Content = Record<string, unknown>
type SendFn = (jid: string, content: any, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>

/** What `makeHelpers` needs from the socket (a subset, so it is easy to test) */
export type HelperSocket = {
	user?: { id: string; lid?: string } | undefined
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ev: { on: (event: any, listener: (...args: any[]) => void) => void; emit: (event: any, data: any) => unknown }
	sendMessage: SendFn
	updateMediaMessage: (message: WAMessage) => Promise<WAMessage>
	signalRepository?: {
		lidMapping?: {
			getPNForLID?: (lid: string) => Promise<string | null>
			getLIDForPN?: (pn: string) => Promise<string | null>
		}
	}
}

export type HelperConfig = {
	logger?: { debug: (...args: any[]) => void; warn: (...args: any[]) => void }
	getMessage?: (key: WAMessageKey) => Promise<WAMessage['message'] | undefined>
}

const MAX_TRACKED_POLLS = 200

/**
 * Shortcuts that every bot ends up writing by hand. `makeWASocket` already adds them
 * to the socket, so normally you just call `sock.reply(msg, 'hi')`.
 */
export const makeHelpers = (sock: HelperSocket, config: HelperConfig = {}) => {
	// ---- poll tracking -------------------------------------------------------
	type Tracked = { message: WAMessage['message']; key: WAMessageKey; updates: Map<string, any> }
	const polls = new Map<string, Tracked>()

	const pollIdOf = (key: WAMessageKey | undefined | null) => (key?.id ? `${key.remoteJid || ''}|${key.id}` : undefined)

	const remember = (msg: WAMessage | undefined | null) => {
		const id = pollIdOf(msg?.key)
		const content = msg?.message
		if (!id || !content) return
		if (!(content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3)) return
		if (!polls.has(id)) {
			polls.set(id, { message: content, key: msg!.key, updates: new Map() })
			// forget the oldest polls so a long-running bot does not grow forever
			if (polls.size > MAX_TRACKED_POLLS) polls.delete(polls.keys().next().value as string)
		}
	}

	const aggregate = (tracked: Tracked, meId?: string) =>
		getAggregateVotesInPollMessage({ message: tracked.message, pollUpdates: [...tracked.updates.values()] }, meId).map(
			option => ({ name: option.name, voters: option.voters })
		)

	const pollName = (message: WAMessage['message']) =>
		message?.pollCreationMessage?.name ||
		message?.pollCreationMessageV2?.name ||
		message?.pollCreationMessageV3?.name ||
		''

	sock.ev.on('messages.upsert', ({ messages }: { messages: WAMessage[] }) => {
		for (const msg of messages || []) remember(msg)
	})

	sock.ev.on('messages.update', async (updates: WAMessageUpdate[]) => {
		for (const { key, update } of updates || []) {
			const incoming = update?.pollUpdates
			const id = pollIdOf(key)
			if (!incoming?.length || !id) continue

			try {
				let tracked = polls.get(id)
				if (!tracked && config.getMessage) {
					const stored = await config.getMessage(key)
					if (stored) {
						remember({ key, message: stored } as WAMessage)
						tracked = polls.get(id)
					}
				}

				if (!tracked) {
					config.logger?.debug({ key }, 'poll vote ignored: the poll message is unknown (provide getMessage)')
					continue
				}

				for (const vote of incoming) {
					const voter = vote.pollUpdateMessageKey?.participant || vote.pollUpdateMessageKey?.remoteJid || ''
					tracked.updates.set(voter, vote)

					sock.ev.emit('poll.votes', {
						pollKey: tracked.key,
						pollName: pollName(tracked.message),
						votes: aggregate(tracked, sock.user?.id),
						voter
					} satisfies PollVotes)
				}
			} catch (error) {
				config.logger?.warn({ error }, 'could not process a poll vote')
			}
		}
	})

	// ---- helpers ---------------------------------------------------------------
	const toContent = (content: string | Content): Content => (typeof content === 'string' ? { text: content } : content)

	const chatOf = (msg: Pick<WAMessage, 'key'>) => {
		const jid = msg.key.remoteJid
		if (!jid) throw new Boom('The message has no chat (key.remoteJid)', { statusCode: 400 })
		return jid
	}

	return {
		/**
		 * Who sent the message: phone number, LID and WhatsApp's internal id, resolving the missing
		 * one through the LID mapping. Never throws.
		 */
		getSender: async (msg: WAMessage): Promise<SenderInfo> => {
			const base = getSenderIds(msg, sock.user)
			let { pn, lid } = base

			try {
				const mapping = sock.signalRepository?.lidMapping
				if (lid && !pn && mapping?.getPNForLID) {
					const found = await mapping.getPNForLID(lid)
					if (found) pn = jidNormalizedUser(found)
				} else if (pn && !lid && mapping?.getLIDForPN) {
					const found = await mapping.getLIDForPN(pn)
					if (found) lid = jidNormalizedUser(found)
				}
			} catch (error) {
				config.logger?.debug({ error }, 'could not resolve the sender through the LID mapping')
			}

			return buildSender({ chat: base.chat, isGroup: base.isGroup, fromMe: base.fromMe, pn, lid })
		},

		/** Replies quoting the message. `content` can be a plain string. */
		reply: (msg: WAMessage, content: string | Content, options: MiscMessageGenerationOptions = {}) =>
			sock.sendMessage(chatOf(msg), toContent(content), { quoted: msg, ...options }),

		/** Reacts to a message with an emoji (empty string removes the reaction). */
		react: (msg: WAMessage, emoji: string) => sock.sendMessage(chatOf(msg), { react: { text: emoji, key: msg.key } }),

		/** Sends a message with buttons. */
		sendButtons: (jid: string, { buttons, ...rest }: SendButtonsOptions, options?: MiscMessageGenerationOptions) => {
			if (!Array.isArray(buttons) || !buttons.length) {
				throw new Boom('sendButtons needs at least one button', { statusCode: 400 })
			}

			return sock.sendMessage(jid, { ...rest, buttons }, options)
		},

		/** Sends a list (dropdown) message. */
		sendList: (jid: string, { sections, ...rest }: SendListOptions, options?: MiscMessageGenerationOptions) => {
			if (!Array.isArray(sections) || !sections.length) {
				throw new Boom('sendList needs at least one section', { statusCode: 400 })
			}

			const normalized = sections.map(section => ({
				...section,
				rows: section.rows.map(({ id, rowId, ...row }) => ({ ...row, rowId: rowId ?? id ?? row.title }))
			}))
			return sock.sendMessage(jid, { buttonText: 'Ver opciones', ...rest, sections: normalized }, options)
		},

		/** Sends a poll and starts tracking its votes (see the `poll.votes` event and `getPollVotes`). */
		sendPoll: async (
			jid: string,
			name: string,
			values: string[],
			poll: Partial<Omit<PollMessageOptions, 'name' | 'values'>> = {},
			options?: MiscMessageGenerationOptions
		) => {
			const sent = await sock.sendMessage(jid, { poll: { name, values, selectableCount: 1, ...poll } }, options)
			remember(sent)
			return sent
		},

		/** Current results of a poll created by (or seen by) this socket. */
		getPollVotes: (pollKey: WAMessageKey | string) => {
			const id =
				typeof pollKey === 'string' ? [...polls.keys()].find(entry => entry.endsWith(`|${pollKey}`)) : pollIdOf(pollKey)
			const tracked = id ? polls.get(id) : undefined
			if (!tracked) return undefined
			return {
				pollKey: tracked.key,
				pollName: pollName(tracked.message),
				votes: aggregate(tracked, sock.user?.id)
			}
		},

		/**
		 * Downloads the media of a message (image, video, audio, document, sticker) in one call,
		 * re-requesting the upload from the phone when the file expired.
		 */
		downloadMedia: async (msg: WAMessage, options: DownloadMediaOptions = {}): Promise<Buffer> => {
			let target = msg

			if (options.quoted) {
				const content = msg.message || {}
				const type = Object.keys(content).find(entry => (content as any)[entry]?.contextInfo)
				const context = type ? (content as any)[type].contextInfo : undefined
				if (!context?.quotedMessage) throw new Boom('The message does not reply to anything', { statusCode: 400 })
				target = {
					key: { remoteJid: msg.key.remoteJid, id: context.stanzaId, participant: context.participant },
					message: context.quotedMessage
				} as WAMessage
			}

			return downloadMediaMessage(
				target,
				'buffer',
				{},
				{
					reuploadRequest: sock.updateMediaMessage,
					logger: (config.logger || { debug() {}, warn() {} }) as never
				}
			)
		}
	}
}

export type Helpers = ReturnType<typeof makeHelpers>
