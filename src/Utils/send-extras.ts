import { Boom } from '@hapi/boom'
import type { MiscMessageGenerationOptions, WAMessage } from '../Types'

type SendFn = (jid: string, content: any, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>

export type ExtrasSocket = { sendMessage: SendFn }

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

const MAX_ALBUM = 10

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
export const makeSendExtras = (sock: ExtrasSocket, sleep?: (ms: number) => Promise<void>) => {
	const wait = sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

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
		sendAlbum: async (jid: string, items: AlbumItem[], options?: MiscMessageGenerationOptions) => {
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
		},

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
		}
	}
}

export type SendExtras = ReturnType<typeof makeSendExtras>
