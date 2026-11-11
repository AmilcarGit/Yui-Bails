import { describe, expect, it, jest } from '@jest/globals'
import type { WAMessage } from '../../Types'
import { buildVCard, makeSendExtras, splitText } from '../../Utils/send-extras'

const setup = () => {
	let counter = 0
	const sendMessage = jest.fn(
		async (jid: string, content: unknown, options?: unknown) =>
			({
				key: { remoteJid: jid, id: `M${++counter}`, fromMe: true },
				message: content,
				options
			}) as unknown as WAMessage
	)
	const extras = makeSendExtras({ sendMessage: sendMessage as never }, async () => undefined)
	return { extras, sendMessage }
}

const JID = '51900000000@s.whatsapp.net'

describe('buildVCard', () => {
	it('builds a card with the waid', () => {
		expect(buildVCard({ name: 'Ana', number: '+51 900-000-001', organization: 'Yui' })).toBe(
			'BEGIN:VCARD\nVERSION:3.0\nFN:Ana\nORG:Yui;\nTEL;type=CELL;type=VOICE;waid=51900000001:+51900000001\nEND:VCARD'
		)
	})

	it('escapes separators and rejects numbers without digits', () => {
		expect(buildVCard({ name: 'Pérez, Ana;\nX', number: '1' })).toContain('FN:Pérez\\, Ana\\; X')
		expect(() => buildVCard({ name: 'Ana', number: 'abc' })).toThrow(/phone number/)
	})
})

describe('splitText', () => {
	it('keeps short texts whole', () => {
		expect(splitText('hola', 4000)).toEqual(['hola'])
	})

	it('cuts on paragraphs, then lines, then spaces, without losing words', () => {
		const text = 'uno dos tres\n\ncuatro cinco seis\nsiete ocho nueve diez'
		const parts = splitText(text, 20)

		expect(parts.every(part => part.length <= 20)).toBe(true)
		expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
	})

	it('hard-cuts a word longer than the limit', () => {
		expect(splitText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
	})

	it('rejects tiny limits', () => {
		expect(() => splitText('hola', 3)).toThrow(/maxLength/)
	})
})

describe('makeSendExtras', () => {
	it('sendContact: one number as text, one object or several', async () => {
		const { extras, sendMessage } = setup()
		await extras.sendContact(JID, '51900000001')
		await extras.sendContact(JID, { name: 'Ana', number: '51900000002' })
		await extras.sendContact(JID, [
			{ name: 'A', number: '1' },
			{ name: 'B', number: '2' }
		])

		const [first, second, third] = sendMessage.mock.calls.map(call => (call[1] as any).contacts)
		expect(first.contacts).toHaveLength(1)
		expect(second.displayName).toBe('Ana')
		expect(third.displayName).toBe('2 contactos')
		expect(third.contacts[1].vcard).toContain('waid=2')
		expect(() => extras.sendContact(JID, [])).toThrow(/at least one/)
	})

	it('sendLocation sends the pin and validates coordinates', async () => {
		const { extras, sendMessage } = setup()
		await extras.sendLocation(JID, { latitude: -12.04, longitude: -77.03, name: 'Lima' })

		expect(sendMessage.mock.calls[0]![1]).toEqual({
			location: { degreesLatitude: -12.04, degreesLongitude: -77.03, name: 'Lima', address: undefined }
		})
		expect(() => extras.sendLocation(JID, { latitude: 91, longitude: 0 })).toThrow(/Invalid coordinates/)
		expect(() => extras.sendLocation(JID, { latitude: Number.NaN, longitude: 0 })).toThrow(/Invalid coordinates/)
	})

	it('sendAlbum sends the parent first and ties every item to it', async () => {
		const { extras, sendMessage } = setup()
		const result = await extras.sendAlbum(JID, [
			{ image: { url: 'https://x.test/1.jpg' }, caption: 'uno' },
			{ video: { url: 'https://x.test/2.mp4' } },
			{ image: { url: 'https://x.test/3.jpg' } }
		])

		expect((sendMessage.mock.calls[0]![1] as any).album).toEqual({ expectedImageCount: 2, expectedVideoCount: 1 })
		const children = sendMessage.mock.calls.slice(1).map(call => call[1] as any)
		expect(children).toHaveLength(3)
		for (const child of children) expect(child.albumParentKey).toEqual(result.album.key)
		expect(children[0].caption).toBe('uno')
		expect(result.items).toHaveLength(3)
	})

	it('sendAlbum needs 2 to 10 items', async () => {
		const { extras } = setup()
		await expect(extras.sendAlbum(JID, [{ image: {} }])).rejects.toThrow(/between 2 and 10/)
		await expect(
			extras.sendAlbum(
				JID,
				Array.from({ length: 11 }, () => ({ image: {} }))
			)
		).rejects.toThrow(/between 2 and 10/)
	})

	it('sendEvent accepts dates as Date, ms or text', async () => {
		const { extras, sendMessage } = setup()
		await extras.sendEvent(JID, {
			name: 'Fiesta',
			start: '2026-12-24T20:00:00Z',
			end: Date.parse('2026-12-24T23:00:00Z'),
			location: 'Mi casa',
			call: 'video'
		})

		const event = (sendMessage.mock.calls[0]![1] as any).event
		expect(event.startDate).toEqual(new Date('2026-12-24T20:00:00Z'))
		expect(event.endDate).toEqual(new Date('2026-12-24T23:00:00Z'))
		expect(event.location).toEqual({ name: 'Mi casa' })
		expect(event.call).toBe('video')
	})

	it('sendEvent rejects bad input', () => {
		const { extras } = setup()
		expect(() => extras.sendEvent(JID, { name: '', start: new Date() })).toThrow(/name/)
		expect(() => extras.sendEvent(JID, { name: 'x', start: 'mañana' })).toThrow(/Invalid start/)
		expect(() => extras.sendEvent(JID, { name: 'x', start: 2000, end: 1000 })).toThrow(/cannot end/)
	})

	it('sendLong splits the text, keeps order and only the first part quotes', async () => {
		const { extras, sendMessage } = setup()
		const quoted = { key: { id: 'Q' } } as unknown as WAMessage
		const result = await extras.sendLong(JID, `${'a'.repeat(15)} ${'b'.repeat(15)}`, { maxLength: 20 }, { quoted })

		expect(result).toHaveLength(2)
		expect(sendMessage.mock.calls.map(call => (call[1] as any).text)).toEqual(['a'.repeat(15), 'b'.repeat(15)])
		expect((sendMessage.mock.calls[0]![2] as any).quoted).toBe(quoted)
		expect((sendMessage.mock.calls[1]![2] as any).quoted).toBeUndefined()
	})

	it('sendLong waits between parts when asked', async () => {
		const sleeps: number[] = []
		const sendMessage = jest.fn(async () => undefined)
		const extras = makeSendExtras({ sendMessage: sendMessage as never }, async ms => void sleeps.push(ms))

		await extras.sendLong(JID, `${'a'.repeat(15)} ${'b'.repeat(15)} ${'c'.repeat(15)}`, { maxLength: 20, delayMs: 700 })
		expect(sleeps).toEqual([700, 700])
	})

	it('sendLong rejects empty text', async () => {
		const { extras } = setup()
		await expect(extras.sendLong(JID, '   ')).rejects.toThrow(/some text/)
	})
})
