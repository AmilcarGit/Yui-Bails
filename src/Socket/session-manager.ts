import { Boom } from '@hapi/boom'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import path from 'path'
import { DisconnectReason, type UserFacingSocketConfig } from '../Types'
import { useMultiFileAuthState } from '../Utils/use-multi-file-auth-state'
import makeWASocket from './index'

export type YuiSocket = ReturnType<typeof makeWASocket>

export type SessionManagerOptions = {
	/** folder where each session keeps its login: `<authDir>/<sessionId>/` */
	authDir: string
	/** socket config shared by every session, or a function that builds it per session */
	config?: Partial<UserFacingSocketConfig> | ((sessionId: string) => Partial<UserFacingSocketConfig>)
	/** called every time a socket is created (also on reconnects): attach your event handlers here */
	setup?: (sock: YuiSocket, sessionId: string) => void | Promise<void>
	/** reconnect by itself when the connection drops (not after a logout). Default true */
	autoReconnect?: boolean
	/** first reconnect delay in ms, doubled each attempt up to `maxReconnectDelayMs`. Default 2000 */
	reconnectDelayMs?: number
	maxReconnectDelayMs?: number
	/** replaceable for tests */
	makeSocket?: (config: UserFacingSocketConfig) => YuiSocket
	sleep?: (ms: number) => Promise<void>
}

export type StartSessionOptions = {
	/** phone number (digits, with country code) to log in with a pairing code instead of a QR */
	pairingNumber?: string
	/** extra socket config for this session only */
	config?: Partial<UserFacingSocketConfig>
}

export type SessionStatus = 'connecting' | 'open' | 'closed' | 'logged-out'

export type SessionInfo = {
	id: string
	status: SessionStatus
	/** the logged-in account, once connected */
	user: YuiSocket['user']
	reconnects: number
}

type Session = {
	id: string
	sock?: YuiSocket
	status: SessionStatus
	reconnects: number
	stopped: boolean
	options: StartSessionOptions
}

/** Session ids become folder names, so only safe characters are accepted. */
const VALID_ID = /^[A-Za-z0-9][\w.-]{0,63}$/

export type SessionManagerEvents = {
	/** a QR code to scan for this session */
	'session.qr': { id: string; qr: string }
	/** a pairing code to type in WhatsApp > Linked devices > Link with phone number */
	'session.pairing-code': { id: string; code: string }
	'session.open': { id: string; user: YuiSocket['user'] }
	/** the connection dropped; `willReconnect` tells whether the manager will retry */
	'session.close': { id: string; reason: number | undefined; willReconnect: boolean }
	/** the account logged out (or removed the device): its saved login was deleted */
	'session.logged-out': { id: string }
	'session.error': { id: string; error: unknown }
}

/**
 * Runs several WhatsApp numbers in one process. Each session has its own login folder, its own
 * socket and its own automatic reconnection.
 */
export const makeSessionManager = (options: SessionManagerOptions) => {
	const emitter = new EventEmitter()
	const sessions = new Map<string, Session>()
	const makeSocket = options.makeSocket || makeWASocket
	const sleepFn = options.sleep
	const autoReconnect = options.autoReconnect ?? true
	const baseDelay = options.reconnectDelayMs ?? 2000
	const maxDelay = options.maxReconnectDelayMs ?? 30_000

	const emit = <K extends keyof SessionManagerEvents>(event: K, data: SessionManagerEvents[K]) =>
		emitter.emit(event, data)

	const authPath = (id: string) => path.join(options.authDir, id)

	const assertId = (id: string) => {
		if (typeof id !== 'string' || !VALID_ID.test(id) || id.includes('..')) {
			throw new Boom(`Invalid session id "${id}": use letters, numbers, "_", "-" or "."`, { statusCode: 400 })
		}
	}

	const delay = (ms: number) => (sleepFn ? sleepFn(ms) : new Promise<void>(resolve => setTimeout(resolve, ms)))

	const connect = async (session: Session) => {
		session.status = 'connecting'

		try {
			const { state, saveCreds } = await useMultiFileAuthState(authPath(session.id))
			const base = typeof options.config === 'function' ? options.config(session.id) : options.config || {}

			const sock = makeSocket({ ...base, ...session.options.config, auth: state } as UserFacingSocketConfig)
			session.sock = sock

			let pairingAsked = false

			sock.ev.on('creds.update', saveCreds)
			sock.ev.on('connection.update', async update => {
				if (session.sock !== sock) return // an old socket that is still talking

				const { connection, lastDisconnect, qr } = update

				if (qr) {
					const number = session.options.pairingNumber
					if (number && !state.creds.registered) {
						// the pairing code replaces the QR, and it can only be asked once per socket
						if (!pairingAsked) {
							pairingAsked = true
							try {
								const code = await sock.requestPairingCode(number.replace(/\D/g, ''))
								emit('session.pairing-code', { id: session.id, code })
							} catch (error) {
								emit('session.error', { id: session.id, error })
							}
						}
					} else {
						emit('session.qr', { id: session.id, qr })
					}
				}

				if (connection === 'open') {
					session.status = 'open'
					session.reconnects = 0
					emit('session.open', { id: session.id, user: sock.user })
				}

				if (connection === 'close') {
					const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode

					if (reason === DisconnectReason.loggedOut) {
						session.status = 'logged-out'
						session.stopped = true
						await fs.rm(authPath(session.id), { recursive: true, force: true }).catch(() => undefined)
						emit('session.close', { id: session.id, reason, willReconnect: false })
						emit('session.logged-out', { id: session.id })
						return
					}

					session.status = 'closed'
					const willReconnect = autoReconnect && !session.stopped
					emit('session.close', { id: session.id, reason, willReconnect })

					if (willReconnect) {
						// "restart required" is a normal step of the first login: retry right away
						const wait =
							reason === DisconnectReason.restartRequired ? 0 : Math.min(maxDelay, baseDelay * 2 ** session.reconnects)
						session.reconnects += 1
						await delay(wait)
						if (!session.stopped && session.sock === sock) await connect(session)
					}
				}
			})

			await options.setup?.(sock, session.id)
		} catch (error) {
			session.status = 'closed'
			emit('session.error', { id: session.id, error })
		}
	}

	const manager = {
		/** Starts (or returns the already running) session. */
		start: async (id: string, startOptions: StartSessionOptions = {}): Promise<YuiSocket | undefined> => {
			assertId(id)

			const existing = sessions.get(id)
			if (existing && !existing.stopped) return existing.sock

			const session: Session = { id, status: 'connecting', reconnects: 0, stopped: false, options: startOptions }
			sessions.set(id, session)
			await connect(session)
			return session.sock
		},

		/** The live socket of a session. */
		get: (id: string) => sessions.get(id)?.sock,

		/** Every session with its status. */
		list: (): SessionInfo[] =>
			[...sessions.values()].map(session => ({
				id: session.id,
				status: session.status,
				user: session.sock?.user,
				reconnects: session.reconnects
			})),

		/** Closes the connection but keeps the saved login, so `start(id)` brings it back. */
		stop: async (id: string) => {
			const session = sessions.get(id)
			if (!session) return false
			session.stopped = true
			session.status = 'closed'
			try {
				void session.sock?.end(undefined)
			} catch {
				// already closed
			}

			sessions.delete(id)
			return true
		},

		/** Logs the number out of WhatsApp and deletes its saved login. */
		logout: async (id: string) => {
			assertId(id)
			const session = sessions.get(id)
			if (session) {
				session.stopped = true
				try {
					await session.sock?.logout()
				} catch {
					// the socket may already be closed: the saved login is deleted below anyway
				}

				sessions.delete(id)
			}

			await fs.rm(authPath(id), { recursive: true, force: true })
			return true
		},

		/** Ids that have a saved login in `authDir` (useful to restore everything on boot). */
		saved: async (): Promise<string[]> => {
			const entries = await fs.readdir(options.authDir, { withFileTypes: true }).catch(() => [])
			return entries.filter(entry => entry.isDirectory() && VALID_ID.test(entry.name)).map(entry => entry.name)
		},

		/** Starts every saved session. */
		startAll: async () => {
			const ids = await manager.saved()
			await Promise.all(ids.map(id => manager.start(id)))
			return ids
		},

		/** Stops every running session (call it on shutdown). */
		stopAll: async () => {
			await Promise.all([...sessions.keys()].map(id => manager.stop(id)))
		},

		on: <K extends keyof SessionManagerEvents>(event: K, listener: (data: SessionManagerEvents[K]) => void) => {
			emitter.on(event, listener)
			return manager
		},

		off: <K extends keyof SessionManagerEvents>(event: K, listener: (data: SessionManagerEvents[K]) => void) => {
			emitter.off(event, listener)
			return manager
		}
	}

	return manager
}

export type SessionManager = ReturnType<typeof makeSessionManager>
