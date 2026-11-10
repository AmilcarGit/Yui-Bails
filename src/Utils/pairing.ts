import { Boom } from '@hapi/boom'
import { DisconnectReason } from '../Types'

/**
 * Cleans a phone number for the pairing code: digits only, with the country code, no `+`, spaces,
 * dashes or leading zeros. Throws a `Boom` 400 with a message that says what to fix.
 */
export const normalizePhoneNumber = (input: string): string => {
	const text = String(input ?? '').trim()
	if (!text)
		throw new Boom('Escribe el número del teléfono, con código de país (ej. 51912345678).', { statusCode: 400 })

	if (/[a-z]/i.test(text)) {
		throw new Boom('El número solo puede llevar dígitos (ej. 51912345678), sin letras.', { statusCode: 400 })
	}

	// "+51 912-345-678", "(51) 912 345 678" and "0051912345678" all become 51912345678
	const digits = text.replace(/\D/g, '').replace(/^00+/, '')

	if (!digits) throw new Boom('El número no tiene dígitos. Ejemplo: 51912345678.', { statusCode: 400 })

	if (digits.startsWith('0')) {
		throw new Boom(
			'El número no debe empezar con 0: usa el código de país en su lugar (Perú 51, México 52, España 34…).',
			{ statusCode: 400 }
		)
	}

	if (digits.length < 8) {
		throw new Boom(`El número "${digits}" es muy corto. Incluye el código de país (ej. 51912345678).`, {
			statusCode: 400
		})
	}

	if (digits.length > 15) {
		throw new Boom(`El número "${digits}" es muy largo: WhatsApp acepta hasta 15 dígitos.`, { statusCode: 400 })
	}

	return digits
}

/** `ABCD1234` -> `ABCD-1234`, the way WhatsApp shows it on the phone */
export const formatPairingCode = (code: string): string => {
	const clean = String(code ?? '')
		.replace(/[^0-9a-z]/gi, '')
		.toUpperCase()
	return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

const statusOf = (error: unknown): number | undefined => {
	const err = error as { output?: { statusCode?: number }; data?: unknown } | undefined
	if (typeof err?.output?.statusCode === 'number' && err.output.statusCode !== 500) return err.output.statusCode
	return typeof err?.data === 'number' ? err.data : err?.output?.statusCode
}

const messageOf = (error: unknown): string => (error as { message?: string } | undefined)?.message || ''

/**
 * Says in plain Spanish what went wrong while linking or connecting, and what to try.
 * Works with the errors of `requestPairingCode` and with `connection.update` close reasons.
 */
export const explainLinkError = (error: unknown): string => {
	const code = typeof error === 'number' ? error : statusOf(error)
	const text = messageOf(error)

	if (/rate-overlimit/i.test(text) || code === 429) {
		return 'WhatsApp recibió demasiados intentos seguidos y se tomó un descanso. Espera unos 10-15 minutos sin pedir más códigos y prueba otra vez.'
	}

	if (/phone number|número|digits/i.test(text) && (code === 400 || /digits/i.test(text))) return text

	switch (code) {
		case DisconnectReason.loggedOut:
			return 'La sesión se cerró desde el teléfono (Dispositivos vinculados). Borra la carpeta de sesión y vincula otra vez.'
		case DisconnectReason.badSession:
			return 'La sesión guardada está dañada. Borra la carpeta de sesión y vincula otra vez.'
		case DisconnectReason.connectionReplaced:
			return 'Otra sesión abrió este mismo número: cierra el otro bot o el otro dispositivo vinculado.'
		case DisconnectReason.restartRequired:
			return 'WhatsApp pidió reiniciar la conexión (es normal justo después de vincular). Se reconecta solo.'
		case DisconnectReason.multideviceMismatch:
			return 'WhatsApp rechazó la versión de multidispositivo de esta sesión. Vincula de nuevo.'
		case DisconnectReason.forbidden:
			return 'WhatsApp no deja usar este número ahora (403). Puede estar restringido; espera un tiempo y no insistas.'
		case DisconnectReason.unavailableService:
			return 'El servicio de WhatsApp no está disponible en este momento. Se volverá a intentar solo.'
		case DisconnectReason.connectionClosed:
			return 'La conexión se cerró antes de terminar. Revisa tu internet; se reconecta solo.'
		case DisconnectReason.timedOut:
			return 'WhatsApp tardó demasiado en responder. Revisa tu internet; se reintenta solo.'
		default:
			return text || 'Error desconocido al conectar con WhatsApp.'
	}
}

const isRetryable = (error: unknown): boolean => {
	const code = statusOf(error)
	return code === 408 || code === 429 || code === 503 || /rate-overlimit|timed out/i.test(messageOf(error))
}

export type PairingRetryOptions = {
	/** extra tries after a timeout or a "rate-overlimit" answer. Default 2 */
	retries?: number
	/** first wait in ms, doubled each try. Default 3000 */
	delayMs?: number
	/** replaceable for tests */
	sleep?: (ms: number) => Promise<void>
}

/**
 * Asks for a pairing code with a clean number, and waits and tries again when WhatsApp times
 * out or says "rate-overlimit". A closed connection is not retried here: reconnecting gives a fresh code.
 */
export const requestPairingCodeSafe = async (
	sock: { requestPairingCode: (phoneNumber: string) => Promise<string> },
	phoneNumber: string,
	{ retries = 2, delayMs = 3000, sleep }: PairingRetryOptions = {}
): Promise<string> => {
	const number = normalizePhoneNumber(phoneNumber)
	const wait = sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

	for (let attempt = 0; ; attempt++) {
		try {
			return await sock.requestPairingCode(number)
		} catch (error) {
			if (attempt >= retries || !isRetryable(error)) throw error
			await wait(delayMs * 2 ** attempt)
		}
	}
}
