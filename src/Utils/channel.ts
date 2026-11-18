import { Boom } from '@hapi/boom'

/**
 * Understands what people paste when they mean a channel: the link (`https://whatsapp.com/channel/…`),
 * the bare invite code, or the id (`120363…@newsletter`).
 */
export const parseChannelKey = (input: string): { type: 'invite' | 'jid'; key: string } => {
	const text = typeof input === 'string' ? input.trim() : ''

	if (/^\d{10,30}@newsletter$/.test(text)) return { type: 'jid', key: text }

	const link = /whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,})/i.exec(text)
	if (link?.[1]) return { type: 'invite', key: link[1] }

	if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return { type: 'invite', key: text }

	throw new Boom('That is not a WhatsApp channel link, invite code or id', { statusCode: 400 })
}
