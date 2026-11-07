import { Boom } from '@hapi/boom'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { makeSessionManager, type YuiSocket } from '../../Socket/session-manager'
import { DisconnectReason } from '../../Types'

const fakeSocket = () => {
	const ev = new EventEmitter()
	const sock = {
		ev,
		user: { id: '51900000000:1@s.whatsapp.net' },
		end: jest.fn(),
		logout: jest.fn(async () => undefined),
		requestPairingCode: jest.fn(async () => 'ABCD1234')
	}
	return { sock: sock as unknown as YuiSocket, raw: sock, ev }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

const setup = async (extra = {}) => {
	const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yui-sessions-'))
	const sockets: ReturnType<typeof fakeSocket>[] = []
	const manager = makeSessionManager({
		authDir,
		sleep: async () => undefined,
		makeSocket: () => {
			const made = fakeSocket()
			sockets.push(made)
			return made.sock
		},
		...extra
	})
	return { manager, sockets, authDir }
}

describe('makeSessionManager', () => {
	it('runs several sessions independently, each with its own login folder', async () => {
		const { manager, sockets, authDir } = await setup()
		const a = await manager.start('ventas')
		const b = await manager.start('soporte')

		expect(a).not.toBe(b)
		expect(sockets).toHaveLength(2)
		expect(manager.get('ventas')).toBe(a)
		expect(
			manager
				.list()
				.map(s => s.id)
				.sort()
		).toEqual(['soporte', 'ventas'])
		await expect(fs.stat(path.join(authDir, 'ventas'))).resolves.toBeDefined()
		await manager.stopAll()
	})

	it('returns the running socket instead of starting a second one', async () => {
		const { manager, sockets } = await setup()
		const first = await manager.start('uno')
		expect(await manager.start('uno')).toBe(first)
		expect(sockets).toHaveLength(1)
		await manager.stopAll()
	})

	it('rejects ids that could escape the auth folder', async () => {
		const { manager } = await setup()
		for (const bad of ['../x', 'a/b', '', '.hidden', 'a'.repeat(80), '..']) {
			await expect(manager.start(bad)).rejects.toThrow('Invalid session id')
		}
	})

	it('calls setup for every socket and reports open sessions', async () => {
		const setupFn = jest.fn()
		const { manager, sockets } = await setup({ setup: setupFn })
		const opened = jest.fn()
		manager.on('session.open', opened)

		await manager.start('uno')
		sockets[0]!.ev.emit('connection.update', { connection: 'open' })
		await flush()

		expect(setupFn).toHaveBeenCalledWith(sockets[0]!.sock, 'uno')
		expect(opened).toHaveBeenCalledWith({ id: 'uno', user: sockets[0]!.raw.user })
		expect(manager.list()[0]!.status).toBe('open')
		await manager.stopAll()
	})

	it('reconnects after a drop with a fresh socket', async () => {
		const { manager, sockets } = await setup()
		const closed = jest.fn()
		manager.on('session.close', closed)

		await manager.start('uno')
		const error = new Boom('lost', { statusCode: DisconnectReason.connectionLost })
		sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
		await flush()

		expect(closed).toHaveBeenCalledWith({ id: 'uno', reason: DisconnectReason.connectionLost, willReconnect: true })
		expect(sockets).toHaveLength(2)
		expect(manager.get('uno')).toBe(sockets[1]!.sock)
		await manager.stopAll()
	})

	it('does not reconnect when autoReconnect is off', async () => {
		const { manager, sockets } = await setup({ autoReconnect: false })
		await manager.start('uno')
		const error = new Boom('lost', { statusCode: DisconnectReason.connectionLost })
		sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
		await flush()
		expect(sockets).toHaveLength(1)
	})

	it('a logout deletes the saved login and does not reconnect', async () => {
		const { manager, sockets, authDir } = await setup()
		const loggedOut = jest.fn()
		manager.on('session.logged-out', loggedOut)

		await manager.start('uno')
		const error = new Boom('bye', { statusCode: DisconnectReason.loggedOut })
		sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
		await flush()

		expect(loggedOut).toHaveBeenCalledWith({ id: 'uno' })
		expect(sockets).toHaveLength(1)
		await expect(fs.stat(path.join(authDir, 'uno'))).rejects.toThrow()
	})

	it('asks for a pairing code once when a number is given', async () => {
		const { manager, sockets } = await setup()
		const codes = jest.fn()
		manager.on('session.pairing-code', codes)

		await manager.start('uno', { pairingNumber: '+51 910 227 479' })
		sockets[0]!.ev.emit('connection.update', { qr: 'QR1' })
		sockets[0]!.ev.emit('connection.update', { qr: 'QR2' })
		await flush()

		expect(sockets[0]!.raw.requestPairingCode).toHaveBeenCalledTimes(1)
		expect(sockets[0]!.raw.requestPairingCode).toHaveBeenCalledWith('51910227479')
		expect(codes).toHaveBeenCalledWith({ id: 'uno', code: 'ABCD1234' })
		await manager.stopAll()
	})

	it('emits the QR when no number is given', async () => {
		const { manager, sockets } = await setup()
		const qrs = jest.fn()
		manager.on('session.qr', qrs)
		await manager.start('uno')
		sockets[0]!.ev.emit('connection.update', { qr: 'QR1' })
		await flush()
		expect(qrs).toHaveBeenCalledWith({ id: 'uno', qr: 'QR1' })
		await manager.stopAll()
	})

	it('stop keeps the login, logout removes it, startAll restores saved sessions', async () => {
		const { manager, sockets, authDir } = await setup()
		await manager.start('uno')
		await manager.start('dos')

		expect(await manager.stop('uno')).toBe(true)
		expect(sockets[0]!.raw.end).toHaveBeenCalled()
		expect(manager.get('uno')).toBeUndefined()
		await expect(fs.stat(path.join(authDir, 'uno'))).resolves.toBeDefined()

		await manager.logout('dos')
		expect(sockets[1]!.raw.logout).toHaveBeenCalled()
		await expect(fs.stat(path.join(authDir, 'dos'))).rejects.toThrow()

		expect(await manager.saved()).toEqual(['uno'])
		expect(await manager.startAll()).toEqual(['uno'])
		expect(manager.get('uno')).toBeDefined()
		await manager.stopAll()
	})
})
