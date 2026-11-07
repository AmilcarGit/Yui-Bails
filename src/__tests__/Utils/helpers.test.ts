import { EventEmitter } from 'events'
import type { WAMessage } from '../../Types'
import { sha256 } from '../../Utils/crypto'
import { getSenderIds, type HelperSocket, makeHelpers } from '../../Utils/helpers'

const msg = (key: WAMessage['key'], message?: WAMessage['message']) => ({ key, message }) as WAMessage

const makeSock = (extra: Partial<HelperSocket> = {}) => {
	const ev = new EventEmitter()
	const sendMessage = jest.fn(async (jid: string, content: any) =>
		msg({ remoteJid: jid, id: 'SENT1', fromMe: true }, content)
	)
	const sock = {
		user: { id: '51900000000:3@s.whatsapp.net', lid: '111111111:3@lid' },
		ev,
		sendMessage,
		updateMediaMessage: jest.fn(),
		...extra
	} as unknown as HelperSocket
	return { sock, ev, sendMessage }
}

describe('getSenderIds', () => {
	it('reads a private chat with a phone-number jid', () => {
		const s = getSenderIds(msg({ remoteJid: '51910227479@s.whatsapp.net', id: '1' }))
		expect(s.number).toBe('51910227479')
		expect(s.lid).toBeUndefined()
		expect(s.isGroup).toBe(false)
		expect(s.jid).toBe('51910227479@s.whatsapp.net')
	})

	it('reads a LID private chat and keeps the phone number from remoteJidAlt', () => {
		const s = getSenderIds(
			msg({ remoteJid: '269715926691844@lid', remoteJidAlt: '51910227479@s.whatsapp.net', id: '1' })
		)
		expect(s.id).toBe('269715926691844')
		expect(s.number).toBe('51910227479')
		expect(s.jid).toBe('51910227479@s.whatsapp.net')
	})

	it('uses the participant in groups', () => {
		const s = getSenderIds(
			msg({
				remoteJid: '1203@g.us',
				participant: '269715926691844@lid',
				participantAlt: '51910227479@s.whatsapp.net',
				id: '1'
			})
		)
		expect(s.isGroup).toBe(true)
		expect(s.chat).toBe('1203@g.us')
		expect(s.number).toBe('51910227479')
		expect(s.id).toBe('269715926691844')
	})

	it('returns only the LID when the number is unknown', () => {
		const s = getSenderIds(msg({ remoteJid: '1203@g.us', participant: '269715926691844:7@lid', id: '1' }))
		expect(s.number).toBeUndefined()
		expect(s.lid).toBe('269715926691844@lid')
		expect(s.jid).toBe('269715926691844@lid')
	})

	it('uses the own account for fromMe messages', () => {
		const s = getSenderIds(msg({ remoteJid: '51910227479@s.whatsapp.net', fromMe: true, id: '1' }), {
			id: '51900000000:3@s.whatsapp.net',
			lid: '111111111:3@lid'
		})
		expect(s.fromMe).toBe(true)
		expect(s.number).toBe('51900000000')
		expect(s.id).toBe('111111111')
	})

	it('`is` matches numbers, ids and full jids', () => {
		const s = getSenderIds(
			msg({ remoteJid: '269715926691844@lid', remoteJidAlt: '51910227479@s.whatsapp.net', id: '1' })
		)
		expect(s.is(['51910227479'])).toBe(true)
		expect(s.is('269715926691844')).toBe(true)
		expect(s.is(['+51 910 227 479'])).toBe(true)
		expect(s.is(['269715926691844@lid'])).toBe(true)
		expect(s.is(['51999999999'])).toBe(false)
		expect(s.is([])).toBe(false)
	})
})

describe('makeHelpers', () => {
	it('getSender resolves the missing phone number through the LID mapping', async () => {
		const { sock } = makeSock({
			signalRepository: { lidMapping: { getPNForLID: async () => '51910227479:0@s.whatsapp.net' } }
		})
		const helpers = makeHelpers(sock)
		const s = await helpers.getSender(msg({ remoteJid: '1203@g.us', participant: '269715926691844@lid', id: '1' }))
		expect(s.number).toBe('51910227479')
		expect(s.id).toBe('269715926691844')
	})

	it('getSender never throws when the mapping fails', async () => {
		const { sock } = makeSock({
			signalRepository: {
				lidMapping: {
					getPNForLID: async () => {
						throw new Error('boom')
					}
				}
			}
		})
		const s = await makeHelpers(sock).getSender(msg({ remoteJid: '269715926691844@lid', id: '1' }))
		expect(s.number).toBeUndefined()
		expect(s.id).toBe('269715926691844')
	})

	it('reply quotes the message and accepts plain strings', async () => {
		const { sock, sendMessage } = makeSock()
		const original = msg({ remoteJid: '1203@g.us', id: 'A' })
		await makeHelpers(sock).reply(original, 'hola')
		expect(sendMessage).toHaveBeenCalledWith('1203@g.us', { text: 'hola' }, { quoted: original })
	})

	it('react sends a reaction on the same chat', async () => {
		const { sock, sendMessage } = makeSock()
		const original = msg({ remoteJid: '1203@g.us', id: 'A' })
		await makeHelpers(sock).react(original, '🔥')
		expect(sendMessage).toHaveBeenCalledWith('1203@g.us', { react: { text: '🔥', key: original.key } })
	})

	it('sendButtons and sendList validate and shape the content', async () => {
		const { sock, sendMessage } = makeSock()
		const helpers = makeHelpers(sock)

		await helpers.sendButtons('1@s.whatsapp.net', { text: 'Elige', buttons: [{ id: 'a', text: 'A' }] })
		expect(sendMessage).toHaveBeenLastCalledWith(
			'1@s.whatsapp.net',
			{ text: 'Elige', buttons: [{ id: 'a', text: 'A' }] },
			undefined
		)
		expect(() => helpers.sendButtons('1@s.whatsapp.net', { buttons: [] })).toThrow('at least one button')

		await helpers.sendList('1@s.whatsapp.net', {
			text: 'Menú',
			sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Uno' }, { title: 'Dos' }] }]
		})
		const content = sendMessage.mock.calls.at(-1)![1]
		expect(content.buttonText).toBe('Ver opciones')
		expect(content.sections[0].rows).toEqual([
			{ title: 'Uno', rowId: 'r1' },
			{ title: 'Dos', rowId: 'Dos' }
		])
		expect(() => helpers.sendList('1@s.whatsapp.net', { sections: [] })).toThrow('at least one section')
	})

	it('counts poll votes, replaces a changed vote and emits poll.votes', async () => {
		const { sock, ev, sendMessage } = makeSock()
		sendMessage.mockImplementation(async (jid: string, content: any) =>
			msg(
				{ remoteJid: jid, id: 'POLL1', fromMe: true },
				{
					pollCreationMessage: {
						name: content.poll.name,
						options: content.poll.values.map((optionName: string) => ({ optionName }))
					}
				}
			)
		)
		const helpers = makeHelpers(sock)
		const events: any[] = []
		ev.on('poll.votes', (data: any) => events.push(data))

		const sent = await helpers.sendPoll('1203@g.us', 'Color', ['Rojo', 'Azul'])
		const hash = (name: string) => sha256(Buffer.from(name)) as unknown as Uint8Array
		const vote = (voter: string, option: string) => ({
			pollUpdateMessageKey: { remoteJid: '1203@g.us', participant: voter, id: `V-${voter}-${option}` },
			vote: { selectedOptions: [hash(option)] }
		})

		ev.emit('messages.update', [{ key: sent!.key, update: { pollUpdates: [vote('a@s.whatsapp.net', 'Rojo')] } }])
		ev.emit('messages.update', [{ key: sent!.key, update: { pollUpdates: [vote('b@s.whatsapp.net', 'Rojo')] } }])
		ev.emit('messages.update', [{ key: sent!.key, update: { pollUpdates: [vote('a@s.whatsapp.net', 'Azul')] } }])
		await new Promise(resolve => setImmediate(resolve))

		expect(events).toHaveLength(3)
		const last = helpers.getPollVotes('POLL1')!
		expect(last.pollName).toBe('Color')
		expect(last.votes.find(v => v.name === 'Rojo')!.voters).toEqual(['b@s.whatsapp.net'])
		expect(last.votes.find(v => v.name === 'Azul')!.voters).toEqual(['a@s.whatsapp.net'])
		expect(events[2].voter).toBe('a@s.whatsapp.net')
		expect(helpers.getPollVotes('nope')).toBeUndefined()
	})

	it('downloadMedia with quoted:true fails clearly when nothing is quoted', async () => {
		const { sock } = makeSock()
		await expect(
			makeHelpers(sock).downloadMedia(msg({ remoteJid: '1@s.whatsapp.net', id: '1' }, { conversation: 'hi' }), {
				quoted: true
			})
		).rejects.toThrow('does not reply')
	})
})
