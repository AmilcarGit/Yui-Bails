import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import type { WAMessage } from '../../Types'
import { getSenderIds } from '../../Utils/helpers'
import { getReply, makeReplyTools } from '../../Utils/replies'

const CHAT = '1203@g.us'

const from = (user: string, message: WAMessage['message'], id = `M-${Math.random()}`) =>
	({ key: { remoteJid: CHAT, participant: `${user}@s.whatsapp.net`, id }, message }) as WAMessage

const setup = () => {
	const ev = new EventEmitter()
	const tools = makeReplyTools({ ev, getSender: async msg => getSenderIds(msg) })
	const upsert = async (msg: WAMessage, type = 'notify') => {
		ev.emit('messages.upsert', { messages: [msg], type })
		await new Promise(resolve => setImmediate(resolve))
	}
	return { tools, upsert }
}

describe('getReply', () => {
	it('reads a native-flow quick reply', () => {
		const reply = getReply({
			message: {
				interactiveResponseMessage: {
					body: { text: 'Opción A' },
					contextInfo: { stanzaId: 'MENU1' },
					nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: JSON.stringify({ id: 'a', display_text: 'A' }) }
				}
			}
		})
		expect(reply).toEqual({ type: 'button', id: 'a', text: 'A', quotedId: 'MENU1' })
	})

	it('reads a native-flow dropdown row as a list reply', () => {
		const reply = getReply({
			message: {
				interactiveResponseMessage: {
					nativeFlowResponseMessage: {
						name: 'single_select',
						paramsJson: JSON.stringify({ id: 'fila1', title: 'Uno' })
					}
				}
			}
		})
		expect(reply).toMatchObject({ type: 'list', id: 'fila1', text: 'Uno' })
	})

	it('reads classic buttons, lists and template buttons', () => {
		expect(
			getReply({ message: { buttonsResponseMessage: { selectedButtonId: 'x', selectedDisplayText: 'X' } } })
		).toMatchObject({ type: 'button', id: 'x', text: 'X' })
		expect(
			getReply({
				message: { listResponseMessage: { title: 'T', singleSelectReply: { selectedRowId: 'r' } } }
			})
		).toMatchObject({ type: 'list', id: 'r', text: 'T' })
		expect(getReply({ message: { templateButtonReplyMessage: { selectedId: 't' } } })).toMatchObject({
			type: 'template',
			id: 't'
		})
	})

	it('ignores normal messages and survives broken payloads', () => {
		expect(getReply({ message: { conversation: 'hola' } })).toBeUndefined()
		expect(getReply({ message: null })).toBeUndefined()
		expect(
			getReply({ message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{no' } } } })
		).toMatchObject({ type: 'button', id: '' })
	})
})

const tap = (id: string, quotedId: string, user = 'u1') =>
	from(user, {
		interactiveResponseMessage: {
			contextInfo: { stanzaId: quotedId },
			nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: JSON.stringify({ id }) }
		}
	})

describe('makeReplyTools', () => {
	it('onButton matches by string, regex and function, and can be removed', async () => {
		const { tools, upsert } = setup()
		const byString = jest.fn()
		const byRegex = jest.fn()
		const byFn = jest.fn()
		const off = tools.onButton('menu', byString)
		tools.onButton(/^me/, byRegex)
		tools.onButton(r => r.id.endsWith('nu'), byFn)

		await upsert(tap('menu', 'Q1'))
		expect(byString).toHaveBeenCalledTimes(1)
		expect(byRegex).toHaveBeenCalledTimes(1)
		expect(byFn).toHaveBeenCalledTimes(1)

		off()
		await upsert(tap('menu', 'Q1'))
		expect(byString).toHaveBeenCalledTimes(1)
	})

	it('onList only fires for list rows', async () => {
		const { tools, upsert } = setup()
		const handler = jest.fn()
		tools.onList('x', handler)

		await upsert(tap('x', 'Q1')) // a button, not a list
		expect(handler).not.toHaveBeenCalled()

		await upsert(
			from('u1', {
				interactiveResponseMessage: {
					nativeFlowResponseMessage: { name: 'single_select', paramsJson: JSON.stringify({ id: 'x' }) }
				}
			})
		)
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it('once handles only the first tap on each menu', async () => {
		const { tools, upsert } = setup()
		const run = jest.fn()
		const onUsed = jest.fn()
		tools.onButton('ok', run, { once: true, onUsed })

		await upsert(tap('ok', 'MENU1', 'u1'))
		await upsert(tap('ok', 'MENU1', 'u2'))
		await upsert(tap('ok', 'MENU2', 'u2')) // another menu: counts again

		expect(run).toHaveBeenCalledTimes(2)
		expect(onUsed).toHaveBeenCalledTimes(1)
	})

	it('ignores own messages and non-notify upserts, and survives failing handlers', async () => {
		const { tools, upsert } = setup()
		const run = jest.fn(async () => {
			throw new Error('boom')
		})
		tools.onButton('a', run)

		await upsert(tap('a', 'Q'), 'append')
		expect(run).not.toHaveBeenCalled()

		await upsert(tap('a', 'Q'))
		expect(run).toHaveBeenCalledTimes(1) // the error was contained
	})

	it('awaitReply resolves with the next message of the same person in the same chat', async () => {
		const { tools, upsert } = setup()
		const waiting = tools.awaitReply(from('u1', { conversation: 'pregunta' }), { timeoutMs: 1000 })
		await new Promise(resolve => setImmediate(resolve))

		await upsert(from('u2', { conversation: 'otra persona' }))
		await upsert(from('u1', { conversation: 'mi respuesta' }))

		const answer = await waiting
		expect(answer?.message?.conversation).toBe('mi respuesta')
	})

	it('awaitReply gives undefined on timeout and honours filter', async () => {
		const { tools, upsert } = setup()
		expect(await tools.awaitReply(from('u1', { conversation: 'x' }), { timeoutMs: 10 })).toBeUndefined()

		const waiting = tools.awaitReply(from('u1', { conversation: 'x' }), {
			timeoutMs: 1000,
			filter: m => m.message?.conversation === 'si'
		})
		await new Promise(resolve => setImmediate(resolve))
		await upsert(from('u1', { conversation: 'no' }))
		await upsert(from('u1', { conversation: 'si' }))
		expect((await waiting)?.message?.conversation).toBe('si')
	})
})
