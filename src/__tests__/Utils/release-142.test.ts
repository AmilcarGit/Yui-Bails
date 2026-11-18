import { Boom } from '@hapi/boom'
import { describe, expect, it, jest } from '@jest/globals'
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseChannelKey } from '../../Utils/channel'
import { makeReconnector } from '../../Utils/reconnect'
import { makeSendExtras } from '../../Utils/send-extras'
import { useSingleFileAuthState } from '../../Utils/use-single-file-auth-state'

const closeWith = (statusCode: number) => ({
	connection: 'close',
	lastDisconnect: { error: new Boom('x', { statusCode }) }
})

describe('makeReconnector', () => {
	const setup = (options: Partial<Parameters<typeof makeReconnector>[0]> = {}) => {
		const delays: number[] = []
		const connect = jest.fn<() => unknown>()
		let time = 0
		const onGiveUp = jest.fn<(reason: string, statusCode?: number) => void>()
		const reconnector = makeReconnector({
			connect,
			jitter: 0,
			sleep: async ms => {
				delays.push(ms)
			},
			now: () => time,
			onGiveUp,
			...options
		})
		return { reconnector, connect, delays, onGiveUp, advance: (ms: number) => (time += ms) }
	}

	it('waits longer after each failure, up to the limit', async () => {
		const { reconnector, connect, delays } = setup({ maxDelayMs: 7000 })
		for (let index = 0; index < 4; index++) await reconnector.handle(closeWith(408))
		expect(delays).toEqual([2000, 4000, 7000, 7000])
		expect(connect).toHaveBeenCalledTimes(4)
		expect(reconnector.attempts()).toBe(4)
	})

	it('adds a bounded random extra wait', async () => {
		const { reconnector, delays } = setup({ jitter: 0.5, random: () => 1 })
		await reconnector.handle(closeWith(408))
		expect(delays).toEqual([3000])
	})

	it('starts again from zero after a connection that stayed open', async () => {
		const { reconnector, delays, advance } = setup()
		await reconnector.handle(closeWith(408))
		await reconnector.handle(closeWith(408))
		await reconnector.handle({ connection: 'open' })
		advance(31_000)
		await reconnector.handle(closeWith(408))
		expect(delays).toEqual([2000, 4000, 2000])
	})

	it('does not reset when the connection drops right after opening', async () => {
		const { reconnector, delays, advance } = setup()
		await reconnector.handle(closeWith(408))
		await reconnector.handle({ connection: 'open' })
		advance(1000)
		await reconnector.handle(closeWith(408))
		expect(delays).toEqual([2000, 4000])
	})

	it('gives up when retrying is useless or harmful', async () => {
		const { reconnector, connect, onGiveUp } = setup()
		await reconnector.handle(closeWith(401))
		await reconnector.handle(closeWith(440))
		await reconnector.handle(closeWith(500))
		await reconnector.handle(closeWith(403))
		expect(connect).not.toHaveBeenCalled()
		expect(onGiveUp.mock.calls.map(call => call[0])).toEqual(['logged-out', 'replaced', 'bad-session', 'forbidden'])
	})

	it('restarts at once after pairing without counting it as a failure', async () => {
		const { reconnector, connect, delays } = setup()
		await reconnector.handle(closeWith(515))
		expect(delays).toEqual([0])
		expect(connect).toHaveBeenCalledTimes(1)
		expect(reconnector.attempts()).toBe(0)
	})

	it('gives up after too many failures in a row', async () => {
		const { reconnector, connect, onGiveUp } = setup({ maxRetries: 2 })
		await reconnector.handle(closeWith(408))
		await reconnector.handle(closeWith(408))
		await reconnector.handle(closeWith(408))
		expect(connect).toHaveBeenCalledTimes(2)
		expect(onGiveUp).toHaveBeenCalledWith('too-many-attempts', 408)
	})

	it('ignores a second drop while it is already waiting', async () => {
		let release: () => void = () => undefined
		const gate = new Promise<void>(resolve => (release = resolve))
		const { reconnector, connect } = setup({ sleep: () => gate })
		const first = reconnector.handle(closeWith(408))
		await reconnector.handle(closeWith(408))
		release()
		await first
		expect(connect).toHaveBeenCalledTimes(1)
	})

	it('counts a connect() that throws and keeps trying', async () => {
		const { reconnector, connect, delays } = setup({ maxRetries: 3 })
		connect.mockImplementation(() => {
			throw new Error('boom')
		})
		await reconnector.handle(closeWith(408))
		expect(delays).toEqual([2000, 4000, 8000])
		expect(connect).toHaveBeenCalledTimes(3)
	})

	it('does nothing after stop()', async () => {
		const { reconnector, connect } = setup()
		reconnector.stop()
		await reconnector.handle(closeWith(408))
		expect(connect).not.toHaveBeenCalled()
	})
})

describe('useSingleFileAuthState', () => {
	const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'yui-auth-')), 'sub', 'auth.json')
	const hex = (value: Uint8Array | null | undefined) => Buffer.from(value ?? []).toString('hex')

	it('starts with new credentials and keeps keys and credentials after a restart', async () => {
		const file = await tempFile()
		const first = await useSingleFileAuthState(file, { saveDelayMs: 60_000 })
		const noise = hex(first.state.creds.noiseKey.private)
		expect(noise).not.toBe('')

		await first.state.keys.set({
			'pre-key': { '1': { private: Buffer.from('aa', 'hex'), public: Buffer.from('bb', 'hex') } }
		})
		await first.flush()

		const second = await useSingleFileAuthState(file, { saveDelayMs: 60_000 })
		expect(hex(second.state.creds.noiseKey.private)).toBe(noise)
		const got = await second.state.keys.get('pre-key', ['1', '2'])
		expect(hex(got['1']?.private)).toBe('aa')
		expect(hex(got['1']?.public)).toBe('bb')
		expect(got['2']).toBeNull()
		await second.flush()
	})

	it('removes keys set to null', async () => {
		const file = await tempFile()
		const auth = await useSingleFileAuthState(file, { saveDelayMs: 60_000 })
		await auth.state.keys.set({
			'pre-key': { '1': { private: Buffer.from('aa', 'hex'), public: Buffer.from('bb', 'hex') } }
		})
		await auth.state.keys.set({ 'pre-key': { '1': null } })
		expect((await auth.state.keys.get('pre-key', ['1']))['1']).toBeNull()
		await auth.flush()
		expect(JSON.parse(await readFile(file, 'utf-8')).keys['pre-key']).toEqual({})
	})

	it('writes many changes together after the wait, and saveCreds writes at once', async () => {
		const file = await tempFile()
		const auth = await useSingleFileAuthState(file, { saveDelayMs: 20 })
		await auth.state.keys.set({
			'pre-key': { '7': { private: Buffer.from('01', 'hex'), public: Buffer.from('02', 'hex') } }
		})
		await new Promise(resolve => setTimeout(resolve, 120))
		expect(JSON.parse(await readFile(file, 'utf-8')).keys['pre-key']['7']).toBeDefined()

		auth.state.creds.registered = true
		await auth.saveCreds()
		expect(JSON.parse(await readFile(file, 'utf-8')).creds.registered).toBe(true)
	})

	it('turns app state keys back into their real type', async () => {
		const file = await tempFile()
		const auth = await useSingleFileAuthState(file, { saveDelayMs: 60_000 })
		await auth.state.keys.set({ 'app-state-sync-key': { K: { keyData: Buffer.from('cd', 'hex') } } })
		await auth.flush()
		const again = await useSingleFileAuthState(file, { saveDelayMs: 60_000 })
		const got = await again.state.keys.get('app-state-sync-key', ['K'])
		expect(hex(got['K']?.keyData)).toBe('cd')
		await again.flush()
	})

	it('recovers from a damaged file using the backup, and refuses when there is none', async () => {
		const file = await tempFile()
		const first = await useSingleFileAuthState(file, { saveDelayMs: 60_000 })
		const noise = hex(first.state.creds.noiseKey.private)
		await first.saveCreds()
		// opening again makes the backup of the good file
		await (await useSingleFileAuthState(file, { saveDelayMs: 60_000 })).flush()

		await writeFile(file, '{"creds": brok')
		const recovered = await useSingleFileAuthState(file, { saveDelayMs: 60_000 })
		expect(hex(recovered.state.creds.noiseKey.private)).toBe(noise)

		const lonely = await tempFile()
		await useSingleFileAuthState(lonely).then(auth => auth.saveCreds())
		await writeFile(lonely, 'nope')
		await expect(useSingleFileAuthState(lonely)).rejects.toThrow(/damaged/)
	})

	it('reports a failed delayed save and keeps the data for the next try', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'yui-auth-'))
		const file = join(dir, 'auth.json')
		const onError = jest.fn()
		const auth = await useSingleFileAuthState(file, { saveDelayMs: 10, onError })
		await auth.saveCreds()
		// a folder where the temp file should go makes the write fail
		await mkdir(`${file}.tmp`)
		await auth.state.keys.set({
			'pre-key': { '1': { private: Buffer.from('aa', 'hex'), public: Buffer.from('bb', 'hex') } }
		})
		await new Promise(resolve => setTimeout(resolve, 100))
		expect(onError).toHaveBeenCalled()
	})
})

describe('parseChannelKey / channelInfo', () => {
	it('understands links, codes and ids', () => {
		expect(parseChannelKey('https://whatsapp.com/channel/0029VaABCdef12345')).toEqual({
			type: 'invite',
			key: '0029VaABCdef12345'
		})
		expect(parseChannelKey(' https://www.whatsapp.com/channel/0029VaABCdef12345?x=1 ')).toEqual({
			type: 'invite',
			key: '0029VaABCdef12345'
		})
		expect(parseChannelKey('0029VaABCdef12345')).toEqual({ type: 'invite', key: '0029VaABCdef12345' })
		expect(parseChannelKey('120363012345678901@newsletter')).toEqual({
			type: 'jid',
			key: '120363012345678901@newsletter'
		})
		expect(() => parseChannelKey('hola')).toThrow(/not a WhatsApp channel/)
		expect(() => parseChannelKey(5 as never)).toThrow(/not a WhatsApp channel/)
	})

	it('reads the channel through the socket', async () => {
		const newsletterMetadata = jest.fn(async (type: 'invite' | 'jid', key: string) => ({
			id: `${type}:${key}`,
			name: 'Canal'
		}))
		const extras = makeSendExtras({ sendMessage: jest.fn() as never }, { newsletterMetadata })
		const info = await extras.channelInfo('https://whatsapp.com/channel/0029VaABCdef12345')
		expect(info?.name).toBe('Canal')
		expect(newsletterMetadata).toHaveBeenCalledWith('invite', '0029VaABCdef12345')

		const blind = makeSendExtras({ sendMessage: jest.fn() as never })
		await expect(blind.channelInfo('0029VaABCdef12345')).rejects.toThrow(/cannot read channels/)
	})
})
