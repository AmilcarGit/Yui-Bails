import { describe, expect, it, jest } from '@jest/globals'
import type { WAMessage } from '../../Types'
import { type AutomationSocket, makeAutomation } from '../../Utils/automation'

const fakeSocket = () => {
	const handlers: Record<string, (data: any) => void> = {}
	const readMessages = jest.fn<AutomationSocket['readMessages']>(async () => undefined)
	const sendPresenceUpdate = jest.fn<AutomationSocket['sendPresenceUpdate']>(async () => undefined)
	const sock = {
		ev: { on: (event: string, handler: (data: any) => void) => void (handlers[event] = handler) },
		readMessages,
		sendPresenceUpdate
	} as unknown as AutomationSocket

	return { sock, handlers, readMessages, sendPresenceUpdate }
}

const msg = (remoteJid: string, extra: object = {}) =>
	({ key: { remoteJid, id: 'ID1', fromMe: false, ...extra } }) as unknown as WAMessage

describe('makeAutomation', () => {
	it('does nothing unless asked', () => {
		const { sock, handlers } = fakeSocket()
		makeAutomation(sock, {})
		expect(Object.keys(handlers)).toHaveLength(0)
	})

	it('marks live messages as read, but not history, own messages or statuses', () => {
		const { sock, handlers, readMessages } = fakeSocket()
		makeAutomation(sock, { autoRead: true })

		handlers['messages.upsert']!({ type: 'append', messages: [msg('1@s.whatsapp.net')] })
		handlers['messages.upsert']!({ type: 'notify', messages: [msg('1@s.whatsapp.net', { fromMe: true })] })
		handlers['messages.upsert']!({ type: 'notify', messages: [msg('status@broadcast')] })
		expect(readMessages).not.toHaveBeenCalled()

		handlers['messages.upsert']!({ type: 'notify', messages: [msg('1@s.whatsapp.net'), msg('2@g.us')] })
		expect(readMessages).toHaveBeenCalledTimes(2)
	})

	it('can skip groups or private chats', () => {
		const { sock, handlers, readMessages } = fakeSocket()
		makeAutomation(sock, { autoRead: { groups: false } })

		handlers['messages.upsert']!({ type: 'notify', messages: [msg('2@g.us'), msg('1@s.whatsapp.net')] })
		expect(readMessages).toHaveBeenCalledTimes(1)
		expect(readMessages).toHaveBeenCalledWith([expect.objectContaining({ remoteJid: '1@s.whatsapp.net' })])
	})

	it('waits delayMs before reading', () => {
		const { sock, handlers, readMessages } = fakeSocket()
		const timers: Array<() => void> = []
		makeAutomation(
			sock,
			{ autoRead: { delayMs: 1500 } },
			{ setTimer: ((fn: () => void) => void timers.push(fn)) as unknown as typeof setTimeout }
		)

		handlers['messages.upsert']!({ type: 'notify', messages: [msg('1@s.whatsapp.net')] })
		expect(readMessages).not.toHaveBeenCalled()
		timers[0]!()
		expect(readMessages).toHaveBeenCalledTimes(1)
	})

	it('sets the presence when the connection opens', () => {
		const { sock, handlers, sendPresenceUpdate } = fakeSocket()
		makeAutomation(sock, { autoPresence: 'unavailable' })

		handlers['connection.update']!({ connection: 'connecting' })
		expect(sendPresenceUpdate).not.toHaveBeenCalled()

		handlers['connection.update']!({ connection: 'open' })
		expect(sendPresenceUpdate).toHaveBeenCalledWith('unavailable')
	})
})
