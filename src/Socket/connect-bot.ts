import { Boom } from '@hapi/boom'
import os from 'os'
import path from 'path'
import type { UserFacingSocketConfig } from '../Types'
import { explainLinkError, formatPairingCode, normalizePhoneNumber } from '../Utils/pairing'
import { makeSessionManager, type YuiSocket } from './session-manager'

export type ConnectBotOptions = {
	/** folder where the login is saved (created if missing). Never use `.`, `/` or your home folder */
	authDir: string
	/** phone number to link with a pairing code (with country code). Without it, `onQR` gets a QR to scan */
	number?: string
	/** socket config (logger, sendQueue, prettyLogs…) */
	config?: Partial<UserFacingSocketConfig>
	/** called every time a socket is created, also after a reconnect: attach your event handlers here */
	setup?: (sock: YuiSocket) => void | Promise<void>
	/** the pairing code, ready to type on the phone. By default it is printed in the console */
	onCode?: (info: { code: string; formatted: string; number: string }) => void
	/** a QR string to scan (draw it with a QR library). Used when no `number` is given */
	onQR?: (qr: string) => void
	/** the account is connected */
	onOpen?: (sock: YuiSocket) => void
	/** the connection closed. `message` says why and what to do, in Spanish */
	onClose?: (info: { reason: number | undefined; willReconnect: boolean; message: string }) => void
	onError?: (error: unknown, message: string) => void
	/** reconnect by itself (not after a logout). Default true */
	reconnect?: boolean
	/** extra tries when WhatsApp times out or rate-limits the pairing code. Default 2 */
	pairingRetries?: number
	/** where the default messages go. Default console.log */
	log?: (line: string) => void
	/** replaceable for tests */
	makeSocket?: (config: UserFacingSocketConfig) => YuiSocket
	sleep?: (ms: number) => Promise<void>
}

/** refuses folders where a "delete the session" would be a disaster */
const assertSafeAuthDir = (authDir: string) => {
	if (typeof authDir !== 'string' || !authDir.trim()) {
		throw new Boom('authDir is required: the folder where the login is saved (e.g. "./sesion")', { statusCode: 400 })
	}

	const resolved = path.resolve(authDir)
	const unsafe = [path.parse(resolved).root, os.homedir(), process.cwd()]
	if (unsafe.includes(resolved)) {
		throw new Boom(`authDir "${authDir}" is not a safe login folder: use a dedicated one, like "./sesion"`, {
			statusCode: 400
		})
	}

	return resolved
}

/**
 * Starts one WhatsApp account with everything needed already wired: login folder, pairing code
 * (or QR), reconnection with waits, and error messages in plain Spanish.
 *
 * ```js
 * const bot = await connectBot({ authDir: './sesion', number: '51912345678', setup: sock => { ... } })
 * const sock = await bot.ready // resolves when it is connected
 * ```
 */
export const connectBot = async (options: ConnectBotOptions) => {
	const authDir = assertSafeAuthDir(options.authDir)
	const number = options.number ? normalizePhoneNumber(options.number) : undefined
	const log = options.log || (line => console.log(line))

	const manager = makeSessionManager({
		authDir,
		authPath: () => authDir,
		config: options.config,
		setup: options.setup,
		autoReconnect: options.reconnect ?? true,
		pairingRetries: options.pairingRetries,
		makeSocket: options.makeSocket,
		sleep: options.sleep
	})

	let resolveReady: (sock: YuiSocket) => void = () => undefined
	const ready = new Promise<YuiSocket>(resolve => {
		resolveReady = resolve
	})

	manager.on('session.pairing-code', ({ code }) => {
		const info = { code, formatted: formatPairingCode(code), number: number || '' }
		if (options.onCode) {
			options.onCode(info)
			return
		}

		log(`🔗 Código de vinculación: ${info.formatted}`)
		log(
			'   En el teléfono: WhatsApp > Dispositivos vinculados > Vincular un dispositivo > Vincular con el número de teléfono'
		)
	})

	manager.on('session.qr', ({ qr }) => {
		if (options.onQR) {
			options.onQR(qr)
			return
		}

		log('⚠️ Hay que vincular el número: pasa `number` (código de vinculación) o `onQR` (para dibujar el QR).')
	})

	manager.on('session.open', ({ id }) => {
		const sock = manager.get(id)
		if (!sock) return
		resolveReady(sock)
		options.onOpen?.(sock)
	})

	manager.on('session.close', ({ reason, willReconnect }) => {
		options.onClose?.({ reason, willReconnect, message: explainLinkError(reason) })
	})

	manager.on('session.error', ({ error }) => {
		const message = explainLinkError(error)
		if (options.onError) options.onError(error, message)
		else log(`⚠️ ${message}`)
	})

	await manager.start('main', { pairingNumber: number })

	return {
		/** resolves with the socket the first time the account is connected */
		ready,
		/** the live socket (changes after a reconnect) */
		get sock() {
			return manager.get('main')
		},
		/** closes the connection but keeps the login */
		stop: () => manager.stop('main'),
		/** logs out of WhatsApp and deletes the saved login */
		logout: () => manager.logout('main')
	}
}

export type Bot = Awaited<ReturnType<typeof connectBot>>
