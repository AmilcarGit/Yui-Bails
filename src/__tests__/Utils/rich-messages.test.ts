import { describe, expect, it, jest } from '@jest/globals'
import { EventEmitter } from 'events'
import type { WAMessage } from '../../Types'
import { sha256 } from '../../Utils/crypto'
import { type HelperSocket, makeHelpers } from '../../Utils/helpers'
import { generateWAMessageContent } from '../../Utils/messages'
import { type ExtrasDeps, makeSendExtras } from '../../Utils/send-extras'

const GROUP = '1203@g.us'
const generate = (content: any) => generateWAMessageContent(content, {} as never)

describe('quiz polls', () => {
	it('marks the poll as a quiz with its right answer, by text or by position', async () => {
		const byText = await generate({
			poll: { name: 'Capital', values: ['Lima', 'Quito', 'Bogotá'], correctAnswer: 'Quito' }
		})
		const byIndex = await generate({ poll: { name: 'Capital', values: ['Lima', 'Quito', 'Bogotá'], correctAnswer: 0 } })

		const first = byText.pollCreationMessageV3!
		expect(first.pollType).toBe(1)
		expect(first.correctAnswer).toEqual({ optionName: 'Quito' })
		expect(first.selectableOptionsCount).toBe(1)
		expect(byIndex.pollCreationMessageV3!.correctAnswer).toEqual({ optionName: 'Lima' })
	})

	it('a normal poll has no quiz fields', async () => {
		const poll = await generate({ poll: { name: 'Color', values: ['Rojo', 'Azul'], selectableCount: 1 } })
		expect(poll.pollCreationMessageV3!.pollType ?? 0).toBe(0)
		expect(poll.pollCreationMessageV3!.correctAnswer).toBeFalsy()
	})

	it('rejects an answer that is not an option, or more than one choice', async () => {
		await expect(generate({ poll: { name: 'x', values: ['a', 'b'], correctAnswer: 'c' } })).rejects.toThrow(
			/one of the poll options/
		)
		await expect(generate({ poll: { name: 'x', values: ['a', 'b'], correctAnswer: 5 } })).rejects.toThrow(
			/one of the poll options/
		)
		await expect(
			generate({ poll: { name: 'x', values: ['a', 'b'], correctAnswer: 'a', selectableCount: 2 } })
		).rejects.toThrow(/exactly one/)
	})
})

describe('scheduled call content', () => {
	it('builds the call with its time and type', async () => {
		const start = new Date('2026-12-24T20:00:00Z')
		const voice = await generate({ scheduledCall: { title: 'Reunión', startDate: start } })
		const video = await generate({ scheduledCall: { title: 'Reunión', startDate: start, type: 'video' } })

		expect(Number(voice.scheduledCallCreationMessage!.scheduledTimestampMs)).toBe(start.getTime())
		expect(voice.scheduledCallCreationMessage!.title).toBe('Reunión')
		expect(voice.scheduledCallCreationMessage!.callType).toBe(1)
		expect(video.scheduledCallCreationMessage!.callType).toBe(2)
	})

	it('needs a title and a valid date', async () => {
		await expect(generate({ scheduledCall: { title: '', startDate: new Date() } })).rejects.toThrow(/title/)
		await expect(generate({ scheduledCall: { title: 'x', startDate: new Date('nope') } })).rejects.toThrow(/startDate/)
	})
})

describe('helpers: sendQuiz and getQuizResult', () => {
	it('scores who got the quiz right', async () => {
		const ev = new EventEmitter()
		const sendMessage = jest.fn(
			async (jid: string, content: any) =>
				({
					key: { remoteJid: jid, id: 'QUIZ1', fromMe: true },
					message: {
						pollCreationMessageV3: {
							name: content.poll.name,
							options: content.poll.values.map((optionName: string) => ({ optionName })),
							correctAnswer: { optionName: content.poll.values[content.poll.correctAnswer] }
						}
					}
				}) as unknown as WAMessage
		)
		const sock = {
			user: { id: '51900000000:3@s.whatsapp.net' },
			ev,
			sendMessage,
			updateMediaMessage: jest.fn()
		} as unknown as HelperSocket
		const helpers = makeHelpers(sock)

		const sent = await helpers.sendQuiz(GROUP, 'Capital de Perú', ['Lima', 'Quito'], 0)
		expect((sendMessage.mock.calls[0]![1] as any).poll).toEqual({
			name: 'Capital de Perú',
			values: ['Lima', 'Quito'],
			selectableCount: 1,
			correctAnswer: 0
		})

		const hash = (name: string) => sha256(Buffer.from(name)) as unknown as Uint8Array
		const vote = (voter: string, option: string) => ({
			pollUpdateMessageKey: { remoteJid: GROUP, participant: voter, id: `V-${voter}` },
			vote: { selectedOptions: [hash(option)] }
		})
		ev.emit('messages.update', [
			{
				key: sent!.key,
				update: { pollUpdates: [vote('a@s.whatsapp.net', 'Lima'), vote('b@s.whatsapp.net', 'Quito')] }
			}
		])
		await new Promise(resolve => setImmediate(resolve))

		const result = helpers.getQuizResult('QUIZ1')!
		expect(result.correct).toBe('Lima')
		expect(result.right).toEqual(['a@s.whatsapp.net'])
		expect(result.wrong).toEqual(['b@s.whatsapp.net'])
		expect(helpers.getQuizResult('nope')).toBeUndefined()
	})

	it('a normal poll is not a quiz', async () => {
		const ev = new EventEmitter()
		const sendMessage = jest.fn(
			async (jid: string) =>
				({
					key: { remoteJid: jid, id: 'P1', fromMe: true },
					message: { pollCreationMessageV3: { name: 'x', options: [{ optionName: 'a' }] } }
				}) as unknown as WAMessage
		)
		const helpers = makeHelpers({ ev, sendMessage, updateMediaMessage: jest.fn() } as unknown as HelperSocket)
		await helpers.sendPoll(GROUP, 'x', ['a', 'b'])
		expect(helpers.getQuizResult('P1')).toBeUndefined()
	})
})

describe('send extras: image poll, scheduled call, status mention and ask', () => {
	const setup = (deps = {}) => {
		let counter = 0
		const sendMessage = jest.fn<(jid: string, content: unknown, options?: unknown) => Promise<WAMessage>>(
			async (jid, content) =>
				({ key: { remoteJid: jid, id: `M${++counter}`, fromMe: true }, message: content }) as unknown as WAMessage
		)
		const relayMessage = jest.fn(async () => 'ID')
		const extras = makeSendExtras({ sendMessage: sendMessage as never, relayMessage: relayMessage as never }, deps)
		return { extras, sendMessage, relayMessage }
	}

	it('sendImagePoll sends numbered pictures as an album, then the poll', async () => {
		const sendPoll = jest.fn<NonNullable<ExtrasDeps['sendPoll']>>(
			async () => ({ key: { id: 'POLL' } }) as unknown as WAMessage
		)
		const { extras, sendMessage } = setup({ sendPoll })

		const result = await extras.sendImagePoll(GROUP, {
			name: '¿Cuál prefieres?',
			options: [
				{ text: 'Gato', image: { url: 'https://x.test/gato.jpg' } },
				{ text: 'Perro', image: { url: 'https://x.test/perro.jpg' } }
			]
		})

		const sent = sendMessage.mock.calls.map(call => call[1] as any)
		expect(sent[0].album).toEqual({ expectedImageCount: 2, expectedVideoCount: 0 })
		expect(sent[1].caption).toBe('1️⃣ Gato')
		expect(sent[2].caption).toBe('2️⃣ Perro')
		expect(sendPoll).toHaveBeenCalledWith(
			GROUP,
			'¿Cuál prefieres?',
			['Gato', 'Perro'],
			{ selectableCount: 1 },
			undefined
		)
		expect(result.poll?.key.id).toBe('POLL')
	})

	it('sendImagePoll falls back to a plain poll message and validates the options', async () => {
		const { extras, sendMessage } = setup()
		await extras.sendImagePoll(GROUP, {
			name: 'x',
			options: [
				{ text: 'a', image: {} },
				{ text: 'b', image: {} }
			]
		})
		expect((sendMessage.mock.calls.at(-1)![1] as any).poll).toEqual({
			name: 'x',
			values: ['a', 'b'],
			selectableCount: 1
		})

		await expect(extras.sendImagePoll(GROUP, { name: 'x', options: [{ text: 'a', image: {} }] })).rejects.toThrow(
			/between 2 and 10/
		)
	})

	it('sendScheduledCall accepts dates as text or ms and validates', async () => {
		const { extras, sendMessage } = setup()
		await extras.sendScheduledCall(GROUP, { title: 'Reunión', start: '2026-12-24T20:00:00Z', type: 'video' })

		const call = (sendMessage.mock.calls[0]![1] as any).scheduledCall
		expect(call.startDate).toEqual(new Date('2026-12-24T20:00:00Z'))
		expect(call.type).toBe('video')
		expect(() => extras.sendScheduledCall(GROUP, { title: '', start: new Date() })).toThrow(/title/)
		expect(() => extras.sendScheduledCall(GROUP, { title: 'x', start: 'mañana' })).toThrow(/Invalid start/)
	})

	it('sendStatusMention posts the status to the mentioned people and notifies each one', async () => {
		const { extras, sendMessage, relayMessage } = setup()
		const a = '51900000001@s.whatsapp.net'
		const b = '51900000002@s.whatsapp.net'
		const status = await extras.sendStatusMention(
			{ text: 'Hola a todos' },
			{ mentions: [a, b, a], backgroundColor: '#112233' }
		)

		const [jid, content, options] = sendMessage.mock.calls[0] as unknown as [string, any, any]
		expect(jid).toBe('status@broadcast')
		expect(content).toEqual({ text: 'Hola a todos', mentions: [a, b] })
		expect(options.statusJidList).toEqual([a, b])
		expect(options.backgroundColor).toBe('#112233')
		const meta = options.additionalNodes[0]
		expect(meta.tag).toBe('meta')
		expect(meta.content[0].tag).toBe('mentioned_users')
		expect(meta.content[0].content.map((node: any) => node.attrs.jid)).toEqual([a, b])

		expect(relayMessage).toHaveBeenCalledTimes(2)
		const [target, message, relayOptions] = relayMessage.mock.calls[0] as unknown as [string, any, any]
		expect(target).toBe(a)
		expect(message.statusMentionMessage.message.protocolMessage).toEqual({ key: status.key, type: 25 })
		expect(relayOptions.additionalNodes[0].attrs).toEqual({ is_status_mention: 'true' })
	})

	it('sendStatusMention needs people to mention and a socket that can relay', async () => {
		const { extras } = setup()
		await expect(extras.sendStatusMention({ text: 'x' }, { mentions: [] })).rejects.toThrow(/at least one/)

		const plain = makeSendExtras({ sendMessage: jest.fn() as never })
		await expect(plain.sendStatusMention({ text: 'x' }, { mentions: ['1@s.whatsapp.net'] })).rejects.toThrow(/relay/)
	})

	it('ask sends the question quoted and returns the text of the answer', async () => {
		const answer = { key: { id: 'A' }, message: { extendedTextMessage: { text: 'Lima' } } } as unknown as WAMessage
		const awaitReply = jest.fn<NonNullable<ExtrasDeps['awaitReply']>>(async () => answer)
		const { extras, sendMessage } = setup({ awaitReply })
		const question = { key: { remoteJid: GROUP, id: 'Q' } } as unknown as WAMessage

		await expect(extras.ask(question, '¿Capital de Perú?', { timeoutMs: 5000 })).resolves.toBe('Lima')
		expect(sendMessage).toHaveBeenCalledWith(GROUP, { text: '¿Capital de Perú?' }, { quoted: question })
		expect(awaitReply).toHaveBeenCalledWith(question, { timeoutMs: 5000 })
	})

	it('ask resolves undefined on timeout and fails without awaitReply', async () => {
		const question = { key: { remoteJid: GROUP, id: 'Q' } } as unknown as WAMessage
		const { extras } = setup({ awaitReply: jest.fn(async () => undefined) })
		await expect(extras.ask(question, '¿?')).resolves.toBeUndefined()

		await expect(setup().extras.ask(question, '¿?')).rejects.toThrow(/wait for replies/)
	})
})
