import { Boom } from '@hapi/boom'
import type { MessageRelayOptions, MiscMessageGenerationOptions, WAMessage } from '../Types'
import { WAProto } from '../Types'
import type { BinaryNode } from '../WABinary'
import { generateMessageIDV2 } from './generics'

type SendFn = (jid: string, content: any, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>

export type ExtrasSocket = {
	sendMessage: SendFn
	/** needed by `sendStatusMention` */
	relayMessage?: (jid: string, message: any, options: MessageRelayOptions) => Promise<string>
}

export type ExtrasDeps = {
	/** replaceable in tests */
	sleep?: (ms: number) => Promise<void>
	/** poll sender that also tracks votes (`sock.sendPoll`); without it a plain `sendMessage` is used */
	sendPoll?: (
		jid: string,
		name: string,
		values: string[],
		poll?: { selectableCount?: number },
		options?: MiscMessageGenerationOptions
	) => Promise<WAMessage | undefined>
	/** waits for the next message of a user (`sock.awaitReply`); needed by `ask` */
	awaitReply?: (msg: WAMessage, options?: { timeoutMs?: number }) => Promise<WAMessage | undefined>
}

export type ContactInput = {
	/** name shown in the contact card */
	name: string
	/** phone number with country code; spaces, dashes and `+` are removed */
	number: string
	organization?: string
}

export type LocationInput = {
	latitude: number
	longitude: number
	name?: string
	address?: string
}

export type AlbumItem = ({ image: any } | { video: any }) & { caption?: string }

export type EventInput = {
	name: string
	description?: string
	/** a `Date`, ms since 1970 or an ISO text */
	start: Date | number | string
	end?: Date | number | string
	/** place name */
	location?: string
	call?: 'audio' | 'video'
}

export type SendLongOptions = {
	/** most characters per message. Default 4000 */
	maxLength?: number
	/** wait between parts, in ms. Default 0 (use `sendQueue` for human-like pauses) */
	delayMs?: number
}

export type ImagePollOption = { text: string; image: any }

export type ImagePollInput = {
	name: string
	/** 2 to 10 options, each with its image */
	options: ImagePollOption[]
	selectableCount?: number
}

export type ScheduledCallInput = {
	title: string
	start: Date | number | string
	type?: 'voice' | 'video'
}

export type StatusMentionOptions = {
	/** people (or groups) that get the mention */
	mentions: string[]
	backgroundColor?: string
	font?: number
}

export type AskOptions = {
	/** how long to wait for the answer, in ms. Default 60 s */
	timeoutMs?: number
}

const MAX_ALBUM = 10
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

const toDate = (value: Date | number | string, label: string): Date => {
	const date = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(date.getTime())) throw new Boom(`Invalid ${label} date "${String(value)}"`, { statusCode: 400 })
	return date
}

/** a vCard 3.0 with the `waid` that lets WhatsApp show "Message" / "Add to contacts" */
export const buildVCard = ({ name, number, organization }: ContactInput): string => {
	const digits = number.replace(/\D/g, '')
	if (!digits) throw new Boom('A contact needs a phone number with the country code', { statusCode: 400 })

	const clean = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/([,;\\])/g, '\\$1')
	return [
		'BEGIN:VCARD',
		'VERSION:3.0',
		`FN:${clean(name)}`,
		...(organization ? [`ORG:${clean(organization)};`] : []),
		`TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
		'END:VCARD'
	].join('\n')
}

/** splits a long text on paragraph, line or space boundaries, never in the middle of a word when avoidable */
export const splitText = (text: string, maxLength: number): string[] => {
	if (!Number.isInteger(maxLength) || maxLength < 10) {
		throw new Boom('maxLength must be a whole number of at least 10', { statusCode: 400 })
	}

	const parts: string[] = []
	let rest = text.trim()

	while (rest.length > maxLength) {
		const window = rest.slice(0, maxLength + 1)
		let cut = Math.max(window.lastIndexOf('\n\n'), 0)
		if (cut < maxLength / 2) cut = window.lastIndexOf('\n')
		if (cut < maxLength / 2) cut = window.lastIndexOf(' ')
		if (cut < maxLength / 2) cut = maxLength

		parts.push(rest.slice(0, cut).trimEnd())
		rest = rest.slice(cut).trimStart()
	}

	if (rest) parts.push(rest)
	return parts
}

/** shortcuts for the messages people ask for most: contacts, location, album, event and long text */
export const makeSendExtras = (sock: ExtrasSocket, deps: ExtrasDeps = {}) => {
	const wait = deps.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

	const sendAlbum = async (jid: string, items: AlbumItem[], options?: MiscMessageGenerationOptions) => {
		if (!Array.isArray(items) || items.length < 2 || items.length > MAX_ALBUM) {
			throw new Boom(`An album needs between 2 and ${MAX_ALBUM} items`, { statusCode: 400 })
		}

		const images = items.filter(item => 'image' in item).length
		const videos = items.length - images

		const album = await sock.sendMessage(
			jid,
			{ album: { expectedImageCount: images, expectedVideoCount: videos } },
			options
		)
		if (!album?.key) throw new Boom('WhatsApp did not accept the album', { statusCode: 500 })

		const sent: Array<WAMessage | undefined> = []
		for (const item of items) {
			sent.push(await sock.sendMessage(jid, { ...item, albumParentKey: album.key }, options))
		}

		return { album, items: sent }
	}

	return {
		/** contact card(s). A text is taken as a number: `sendContact(jid, '5731…')` */
		sendContact: (
			jid: string,
			contacts: ContactInput | ContactInput[] | string,
			options?: MiscMessageGenerationOptions
		) => {
			const list: ContactInput[] =
				typeof contacts === 'string'
					? [{ name: contacts, number: contacts }]
					: Array.isArray(contacts)
						? contacts
						: [contacts]
			if (!list.length) throw new Boom('sendContact needs at least one contact', { statusCode: 400 })

			return sock.sendMessage(
				jid,
				{
					contacts: {
						displayName: list.length === 1 ? list[0]!.name : `${list.length} contactos`,
						contacts: list.map(contact => ({ displayName: contact.name, vcard: buildVCard(contact) }))
					}
				},
				options
			)
		},

		/** a map pin */
		sendLocation: (
			jid: string,
			{ latitude, longitude, name, address }: LocationInput,
			options?: MiscMessageGenerationOptions
		) => {
			if (!(latitude >= -90 && latitude <= 90) || !(longitude >= -180 && longitude <= 180)) {
				throw new Boom('Invalid coordinates: latitude is -90 to 90 and longitude is -180 to 180', { statusCode: 400 })
			}

			return sock.sendMessage(
				jid,
				{ location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address } },
				options
			)
		},

		/** 2 to 10 photos / videos that WhatsApp groups in one album */
		sendAlbum,

		/** an event invitation */
		sendEvent: (jid: string, event: EventInput, options?: MiscMessageGenerationOptions) => {
			if (!event?.name) throw new Boom('An event needs a name', { statusCode: 400 })

			const startDate = toDate(event.start, 'start')
			const endDate = event.end === undefined ? undefined : toDate(event.end, 'end')
			if (endDate && endDate < startDate) throw new Boom('The event cannot end before it starts', { statusCode: 400 })

			return sock.sendMessage(
				jid,
				{
					event: {
						name: event.name,
						description: event.description,
						startDate,
						endDate,
						location: event.location ? { name: event.location } : undefined,
						call: event.call
					}
				},
				options
			)
		},

		/** a long text split in several messages, in order. Only the first one quotes */
		sendLong: async (jid: string, text: string, long: SendLongOptions = {}, options?: MiscMessageGenerationOptions) => {
			const parts = splitText(text, long.maxLength ?? 4000)
			if (!parts.length) throw new Boom('sendLong needs some text', { statusCode: 400 })

			const sent: Array<WAMessage | undefined> = []
			for (const [index, part] of parts.entries()) {
				if (index > 0 && long.delayMs) await wait(long.delayMs)
				// only the first part quotes the original message
				const rest = { ...options }
				delete rest.quoted
				sent.push(await sock.sendMessage(jid, { text: part }, index === 0 ? options : rest))
			}

			return sent
		},

		/**
		 * A poll whose options have a picture. WhatsApp's own "poll with images" has no documented
		 * format, so this sends the pictures as an album (each one numbered with its option) and then
		 * a normal poll with the same options: it works on every version.
		 */
		sendImagePoll: async (jid: string, poll: ImagePollInput, options?: MiscMessageGenerationOptions) => {
			const choices = poll?.options
			if (!Array.isArray(choices) || choices.length < 2 || choices.length > MAX_ALBUM) {
				throw new Boom(`An image poll needs between 2 and ${MAX_ALBUM} options`, { statusCode: 400 })
			}

			const album = await sendAlbum(
				jid,
				choices.map((choice, index) => ({ image: choice.image, caption: `${KEYCAPS[index]} ${choice.text}` })),
				options
			)

			const values = choices.map(choice => choice.text)
			const sendPoll =
				deps.sendPoll ||
				((
					target: string,
					name: string,
					list: string[],
					extra?: { selectableCount?: number },
					opts?: MiscMessageGenerationOptions
				) => sock.sendMessage(target, { poll: { name, values: list, selectableCount: 1, ...extra } }, opts))
			const sent = await sendPoll(jid, poll.name, values, { selectableCount: poll.selectableCount ?? 1 }, options)

			return { album, poll: sent }
		},

		/** an invitation to a call at a given time. Experimental: depends on the WhatsApp version that receives it */
		sendScheduledCall: (jid: string, call: ScheduledCallInput, options?: MiscMessageGenerationOptions) => {
			if (!call?.title) throw new Boom('A scheduled call needs a title', { statusCode: 400 })

			return sock.sendMessage(
				jid,
				{ scheduledCall: { title: call.title, startDate: toDate(call.start, 'start'), type: call.type } },
				options
			)
		},

		/**
		 * Posts a status that mentions people, and tells each one. Experimental: it follows what other
		 * libraries do and has not been confirmed by Yui-Bails on real phones.
		 */
		sendStatusMention: async (
			content: Record<string, any>,
			{ mentions, backgroundColor, font }: StatusMentionOptions
		) => {
			const targets = [...new Set((mentions || []).filter(Boolean))]
			if (!targets.length) throw new Boom('sendStatusMention needs at least one jid in `mentions`', { statusCode: 400 })
			if (!sock.relayMessage) throw new Boom('This socket cannot relay messages', { statusCode: 501 })

			const mentionedUsers: BinaryNode = {
				tag: 'meta',
				attrs: {},
				content: [
					{
						tag: 'mentioned_users',
						attrs: {},
						content: targets.map(jid => ({ tag: 'to', attrs: { jid }, content: undefined }) as BinaryNode)
					}
				]
			}

			const status = await sock.sendMessage(
				'status@broadcast',
				{ ...content, mentions: targets },
				{
					statusJidList: targets,
					backgroundColor,
					font,
					additionalNodes: [mentionedUsers]
				}
			)
			if (!status?.key) throw new Boom('WhatsApp did not accept the status', { statusCode: 500 })

			for (const jid of targets) {
				await sock.relayMessage(
					jid,
					{
						statusMentionMessage: {
							message: {
								protocolMessage: { key: status.key, type: WAProto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE }
							}
						}
					},
					{
						messageId: generateMessageIDV2(),
						additionalNodes: [{ tag: 'meta', attrs: { is_status_mention: 'true' }, content: undefined }]
					}
				)
			}

			return status
		},

		/**
		 * Sends a question and waits for the answer of the same person in that chat.
		 * Resolves the text, or `undefined` when time runs out. (A real question box has no documented
		 * format yet; this works everywhere.)
		 */
		ask: async (to: WAMessage, question: string, { timeoutMs = 60_000 }: AskOptions = {}) => {
			if (!deps.awaitReply) throw new Boom('This socket cannot wait for replies', { statusCode: 501 })
			const jid = to.key.remoteJid
			if (!jid) throw new Boom('The message has no chat', { statusCode: 400 })

			await sock.sendMessage(jid, { text: question }, { quoted: to })
			const answer = await deps.awaitReply(to, { timeoutMs })
			if (!answer) return undefined

			const content = answer.message
			return (
				content?.conversation ||
				content?.extendedTextMessage?.text ||
				content?.imageMessage?.caption ||
				content?.videoMessage?.caption ||
				''
			)
		}
	}
}

export type SendExtras = ReturnType<typeof makeSendExtras>
