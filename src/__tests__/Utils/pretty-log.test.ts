import { describe, expect, it } from '@jest/globals'
import type { WAMessage } from '../../Types'
import { attachPrettyEvents, makePrettyLogger, previewMessage } from '../../Utils/pretty-log'

const capture = (level?: 'debug' | 'info') => {
	const lines: string[] = []
	const logger = makePrettyLogger({
		level,
		color: false,
		write: line => void lines.push(line),
		now: () => new Date(2026, 10, 9, 12, 30, 1)
	})
	return { logger, lines }
}

describe('makePrettyLogger', () => {
	it('prints one readable line', () => {
		const { logger, lines } = capture()
		logger.info({}, 'Conectado')
		expect(lines).toEqual(['12:30:01 ℹ Conectado'])
	})

	it('rewrites the "no session" decrypt error in plain Spanish', () => {
		const { logger, lines } = capture()
		logger.error(
			{ key: { participant: '573127510345@s.whatsapp.net' }, err: new Error('No session found to decrypt message') },
			'failed to decrypt message'
		)
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('573127510345')
		expect(lines[0]).toContain('Pídele que lo envíe otra vez')
	})

	it('hides internal noise unless the level is debug', () => {
		const quiet = capture()
		quiet.logger.error({ error: {} }, 'transaction failed, rolling back')
		quiet.logger.warn({}, 'Buffer timeout reached, auto-flushing')
		expect(quiet.lines).toHaveLength(0)

		const loud = capture('debug')
		loud.logger.error({ error: {} }, 'transaction failed, rolling back')
		expect(loud.lines).toHaveLength(1)
	})

	it('explains rate-overlimit', () => {
		const { logger, lines } = capture()
		logger.error({ err: new Error('rate-overlimit') }, 'query failed')
		expect(lines[0]).toContain('más despacio')
	})
})

const text = (conversation: string, extra: object = {}) =>
	({ key: { remoteJid: '5191@s.whatsapp.net', id: 'A' }, message: { conversation }, ...extra }) as unknown as WAMessage

describe('previewMessage', () => {
	it('shows text, cuts long text and names media', () => {
		expect(previewMessage(text('.ping'))).toBe('.ping')
		expect(previewMessage(text('x'.repeat(100)), 10)).toBe('xxxxxxxxx…')
		expect(previewMessage({ key: {}, message: { imageMessage: {} } } as unknown as WAMessage)).toBe('[image]')
	})

	it('ignores WhatsApp bookkeeping messages', () => {
		const internal = (message: object) => ({ key: {}, message }) as unknown as WAMessage
		expect(previewMessage(internal({ protocolMessage: {} }))).toBe('')
		expect(previewMessage(internal({ senderKeyDistributionMessage: {} }))).toBe('')
	})
})

describe('attachPrettyEvents', () => {
	it('logs messages and connection changes', () => {
		const handlers: Record<string, (data: any) => void> = {}
		const lines: string[] = []
		attachPrettyEvents({ ev: { on: (e, h) => void (handlers[e] = h) } }, line => void lines.push(line))

		handlers['messages.upsert']!({ type: 'notify', messages: [text('.ping', { pushName: 'Amilcar' })] })
		handlers['messages.upsert']!({ type: 'append', messages: [text('viejo')] })
		handlers['connection.update']!({ connection: 'open' })

		expect(lines).toHaveLength(2)
		expect(lines[0]).toContain('📩 privado · 5191 · Amilcar: .ping')
		expect(lines[1]).toContain('Conectado')
	})
})
