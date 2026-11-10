import { Boom } from '@hapi/boom'
import { describe, expect, it, jest } from '@jest/globals'
import { explainLinkError, formatPairingCode, normalizePhoneNumber, requestPairingCodeSafe } from '../../Utils/pairing'

describe('normalizePhoneNumber', () => {
	it('cleans the usual ways of writing a number', () => {
		for (const input of ['51912345678', '+51 912 345 678', '(51) 912-345-678', '0051912345678', ' +51912345678 ']) {
			expect(normalizePhoneNumber(input)).toBe('51912345678')
		}
	})

	it('explains what to fix', () => {
		expect(() => normalizePhoneNumber('')).toThrow(/código de país/)
		expect(() => normalizePhoneNumber('abc')).toThrow(/dígitos/)
		expect(() => normalizePhoneNumber('912345678 ext')).toThrow(/dígitos/)
		expect(() => normalizePhoneNumber('0912345678')).toThrow(/empezar con 0/)
		expect(() => normalizePhoneNumber('12345')).toThrow(/muy corto/)
		expect(() => normalizePhoneNumber('1234567890123456')).toThrow(/muy largo/)
		expect(() => normalizePhoneNumber('+ - ()')).toThrow(/no tiene dígitos/)
	})

	it('throws a 400 Boom', () => {
		try {
			normalizePhoneNumber('12')
			throw new Error('should have thrown')
		} catch (error) {
			expect((error as Boom).output.statusCode).toBe(400)
		}
	})
})

describe('formatPairingCode', () => {
	it('groups the 8 characters', () => {
		expect(formatPairingCode('abcd1234')).toBe('ABCD-1234')
		expect(formatPairingCode('ABCD-1234')).toBe('ABCD-1234')
		expect(formatPairingCode('XY')).toBe('XY')
	})
})

describe('explainLinkError', () => {
	it('explains the common failures in Spanish', () => {
		expect(explainLinkError(new Error('rate-overlimit'))).toMatch(/demasiados intentos/)
		expect(explainLinkError(401)).toMatch(/carpeta de sesión/)
		expect(explainLinkError(515)).toMatch(/reiniciar/)
		expect(explainLinkError(440)).toMatch(/Otra sesión/)
		expect(explainLinkError(428)).toMatch(/conexión se cerró/)
		expect(explainLinkError(408)).toMatch(/tardó demasiado/)
		expect(explainLinkError(new Boom('x', { statusCode: 503 }))).toMatch(/no está disponible/)
	})

	it('keeps the message of number errors and falls back to the original text', () => {
		let message = ''
		try {
			normalizePhoneNumber('12')
		} catch (error) {
			message = explainLinkError(error)
		}

		expect(message).toMatch(/muy corto/)
		expect(explainLinkError(new Error('algo raro'))).toBe('algo raro')
		expect(explainLinkError(undefined)).toMatch(/Error desconocido/)
	})
})

describe('requestPairingCodeSafe', () => {
	const limited = () => Object.assign(new Boom('rate-overlimit'), { data: 429 })

	it('sends the cleaned number', async () => {
		const requestPairingCode = jest.fn<(number: string) => Promise<string>>(async () => 'ABCD1234')
		await expect(requestPairingCodeSafe({ requestPairingCode }, '+51 912 345 678')).resolves.toBe('ABCD1234')
		expect(requestPairingCode).toHaveBeenCalledWith('51912345678')
	})

	it('rejects a bad number without calling WhatsApp', async () => {
		const requestPairingCode = jest.fn<(number: string) => Promise<string>>(async () => 'ABCD1234')
		await expect(requestPairingCodeSafe({ requestPairingCode }, '12')).rejects.toThrow(/muy corto/)
		expect(requestPairingCode).not.toHaveBeenCalled()
	})

	it('waits and retries on rate-overlimit', async () => {
		const waits: number[] = []
		let calls = 0
		const requestPairingCode = async () => {
			if (++calls < 3) throw limited()
			return 'ABCD1234'
		}

		await expect(
			requestPairingCodeSafe({ requestPairingCode }, '51912345678', { sleep: async ms => void waits.push(ms) })
		).resolves.toBe('ABCD1234')
		expect(waits).toEqual([3000, 6000])
	})

	it('does not retry a closed connection or keep retrying forever', async () => {
		const closed = jest.fn<(number: string) => Promise<string>>(async () =>
			Promise.reject(new Boom('Connection Closed', { statusCode: 428 }))
		)
		await expect(requestPairingCodeSafe({ requestPairingCode: closed }, '51912345678')).rejects.toThrow(
			'Connection Closed'
		)
		expect(closed).toHaveBeenCalledTimes(1)

		const always = jest.fn<(number: string) => Promise<string>>(async () => Promise.reject(limited()))
		await expect(
			requestPairingCodeSafe({ requestPairingCode: always }, '51912345678', {
				retries: 1,
				sleep: async () => undefined
			})
		).rejects.toThrow('rate-overlimit')
		expect(always).toHaveBeenCalledTimes(2)
	})
})
