import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { connectBot } from '../../Socket/connect-bot'
import type { YuiSocket } from '../../Socket/session-manager'
import { DisconnectReason } from '../../Types'

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

const fakeSocket = () => {
	const ev = new EventEmitter()
	const requestPairingCode = jest.fn<(number: string) => Promise<string>>(async () => 'abcd1234')
	const sock = {
		ev,
		user: { id: '51900000000:1@s.whatsapp.net' },
		end: jest.fn(),
		logout: jest.fn(async () => undefined),
		requestPairingCode
	}
	return { sock: sock as unknown as YuiSocket, ev, requestPairingCode }
}

const start = async (options: Record<string, unknown> = {}) => {
	const authDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'yui-bot-')), 'sesion')
	const sockets: ReturnType<typeof fakeSocket>[] = []
	const lines: string[] = []
	const bot = await connectBot({
		authDir,
		log: line => void lines.push(line),
		sleep: async () => undefined,
		makeSocket: () => {
			const fake = fakeSocket()
			sockets.push(fake)
			return fake.sock
		},
		...options
	})

	return { bot, sockets, lines, authDir }
}

describe('connectBot', () => {
	it('rejects an unsafe login folder', async () => {
		await expect(connectBot({ authDir: '.' })).rejects.toThrow(/not a safe login folder/)
		await expect(connectBot({ authDir: '/' })).rejects.toThrow(/not a safe login folder/)
		await expect(connectBot({ authDir: os.homedir() })).rejects.toThrow(/not a safe login folder/)
		await expect(connectBot({ authDir: '' })).rejects.toThrow(/authDir is required/)
	})

	it('rejects a bad number before connecting', async () => {
		await expect(connectBot({ authDir: './sesion-x', number: '123' })).rejects.toThrow(/muy corto/)
	})

	it('prints the pairing code formatted and with the steps', async () => {
		const { sockets, lines } = await start({ number: '+51 912 345 678' })
		sockets[0]!.ev.emit('connection.update', { qr: 'qr-text' })
		await flush()

		expect(sockets[0]!.requestPairingCode).toHaveBeenCalledWith('51912345678')
		expect(lines[0]).toContain('ABCD-1234')
		expect(lines[1]).toContain('Vincular con el número de teléfono')
	})

	it('gives the code to onCode instead of printing it', async () => {
		const onCode = jest.fn()
		const { sockets, lines } = await start({ number: '51912345678', onCode })
		sockets[0]!.ev.emit('connection.update', { qr: 'qr-text' })
		await flush()

		expect(onCode).toHaveBeenCalledWith({ code: 'abcd1234', formatted: 'ABCD-1234', number: '51912345678' })
		expect(lines).toHaveLength(0)
	})

	it('without a number it hands the QR to onQR, or says what is missing', async () => {
		const onQR = jest.fn()
		const withQr = await start({ onQR })
		withQr.sockets[0]!.ev.emit('connection.update', { qr: 'qr-text' })
		await flush()
		expect(onQR).toHaveBeenCalledWith('qr-text')

		const without = await start()
		without.sockets[0]!.ev.emit('connection.update', { qr: 'qr-text' })
		await flush()
		expect(without.lines[0]).toContain('number')
	})

	it('resolves ready and calls onOpen when connected', async () => {
		const onOpen = jest.fn()
		const { bot, sockets } = await start({ onOpen })
		sockets[0]!.ev.emit('connection.update', { connection: 'open' })

		await expect(bot.ready).resolves.toBe(sockets[0]!.sock)
		expect(onOpen).toHaveBeenCalledTimes(1)
		expect(bot.sock).toBe(sockets[0]!.sock)
	})

	it('explains why the connection closed and reconnects', async () => {
		const onClose = jest.fn()
		const { sockets } = await start({ onClose })
		sockets[0]!.ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: { error: new Boom('restart', { statusCode: DisconnectReason.restartRequired }) }
		})
		await flush()

		expect(onClose).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 515, willReconnect: true, message: expect.stringContaining('reiniciar') })
		)
		expect(sockets).toHaveLength(2)
	})

	it('runs setup on every socket and stops cleanly', async () => {
		const setup = jest.fn()
		const { bot, sockets } = await start({ setup })
		expect(setup).toHaveBeenCalledTimes(1)

		await bot.stop()
		expect(sockets[0]!.sock.end).toHaveBeenCalled()
	})
})
