import type { WAMessage } from '../Types'
import { isJidGroup } from '../WABinary'
import type { ILogger } from './logger'
import { extractMessageContent } from './messages'

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const
type Level = (typeof LEVELS)[number]

export type PrettyLoggerOptions = {
	/** lowest level shown. Default 'info' */
	level?: Level
	/** colors in the terminal. Default true (off when NO_COLOR is set) */
	color?: boolean
	/** where lines go. Default console.log */
	write?: (line: string) => void
	/** clock, replaceable for tests */
	now?: () => Date
}

type Friendly = { test: RegExp; level: Level; text: (obj: any) => string }

/** Known noisy errors, said in plain Spanish. Their level can also be lowered. */
const FRIENDLY: Friendly[] = [
	{
		test: /no session found to decrypt/i,
		level: 'warn',
		text: obj => {
			const who = obj?.key?.participant || obj?.key?.remoteJid
			return `No pude leer un mensaje${who ? ` de ${String(who).split('@')[0]}` : ''}: falta su clave de cifrado. Pídele que lo envíe otra vez.`
		}
	},
	{ test: /transaction failed, rolling back/i, level: 'debug', text: () => 'Se deshizo una operación de claves.' },
	{
		test: /rate-overlimit/i,
		level: 'warn',
		text: () => 'WhatsApp pidió ir más despacio (rate-overlimit). Reduce la velocidad de envío.'
	},
	{ test: /buffer timeout reached/i, level: 'debug', text: () => 'Se liberaron los eventos retenidos tras 30 s.' }
]

const COLORS: Record<Level, number> = { trace: 90, debug: 90, info: 36, warn: 33, error: 31 }
const ICONS: Record<Level, string> = { trace: '·', debug: '·', info: 'ℹ', warn: '⚠', error: '✖' }

const errorMessage = (obj: unknown): string => {
	if (typeof obj === 'string') return obj
	const err = (obj as { err?: unknown; error?: unknown } | undefined)?.err ?? (obj as { error?: unknown })?.error
	if (err instanceof Error) return err.message
	if (typeof (obj as { message?: unknown })?.message === 'string') return (obj as { message: string }).message
	return ''
}

/**
 * A logger that prints one readable line per entry (`12:30:01 ⚠ texto`) instead of JSON, and
 * rewrites well-known errors in plain Spanish. Pass it as `logger` in the socket config.
 */
export const makePrettyLogger = ({
	level = 'info',
	color = !process.env.NO_COLOR,
	write = line => console.log(line),
	now = () => new Date()
}: PrettyLoggerOptions = {}): ILogger => {
	const min = LEVELS.indexOf(level)
	const clock = () => now().toTimeString().slice(0, 8)

	const emit = (lvl: Level, obj: unknown, msg?: string) => {
		const text = msg || (typeof obj === 'string' ? obj : '')
		const friendly = FRIENDLY.find(rule => rule.test.test(text) || rule.test.test(errorMessage(obj)))

		const finalLevel = friendly ? friendly.level : lvl
		if (LEVELS.indexOf(finalLevel) < min) return

		const body = friendly ? friendly.text(obj) : text || errorMessage(obj)
		if (!body) return

		const paint = (value: string) => (color ? `\x1b[${COLORS[finalLevel]}m${value}\x1b[0m` : value)
		write(`${color ? '\x1b[90m' : ''}${clock()}${color ? '\x1b[0m' : ''} ${paint(ICONS[finalLevel])} ${body}`)
	}

	const logger: ILogger = {
		level,
		child: () => logger,
		trace: (obj, msg) => emit('trace', obj, msg),
		debug: (obj, msg) => emit('debug', obj, msg),
		info: (obj, msg) => emit('info', obj, msg),
		warn: (obj, msg) => emit('warn', obj, msg),
		error: (obj, msg) => emit('error', obj, msg)
	}

	return logger
}

/** WhatsApp bookkeeping messages (key exchange, edits, deletes…): nobody wrote them, so they are not logged */
const INTERNAL = ['protocolMessage', 'senderKeyDistributionMessage', 'fastRatchetKeySenderKeyDistributionMessage']

/** the visible text of a message, cut to `max` characters; media shows its type */
export const previewMessage = (msg: WAMessage, max = 60): string => {
	const content = extractMessageContent(msg.message)
	if (!content) return ''

	const text =
		content.conversation ||
		content.extendedTextMessage?.text ||
		content.imageMessage?.caption ||
		content.videoMessage?.caption ||
		content.documentMessage?.caption ||
		content.buttonsResponseMessage?.selectedDisplayText ||
		content.listResponseMessage?.title ||
		content.templateButtonReplyMessage?.selectedDisplayText ||
		''

	if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text

	const kind = Object.keys(content).find(key => key.endsWith('Message') && !INTERNAL.includes(key))
	return kind ? `[${kind.replace(/Message$/, '')}]` : ''
}

type LogSocket = {
	ev: { on: (event: string, handler: (data: any) => void) => void }
}

/**
 * One line per incoming message and per connection change, ready for a console or a hosting panel:
 * `12:30:01 📩 grupo · 51925679896 · Amilcar: .ping`
 */
export const attachPrettyEvents = (sock: LogSocket, write: (line: string) => void = line => console.log(line)) => {
	const clock = () => new Date().toTimeString().slice(0, 8)
	const line = (icon: string, text: string) => write(`${clock()} ${icon} ${text}`)

	sock.ev.on('messages.upsert', ({ messages, type }: { messages: WAMessage[]; type: string }) => {
		if (type !== 'notify') return

		for (const msg of messages) {
			const jid = msg.key.remoteJid
			if (!jid || jid === 'status@broadcast') continue

			const preview = previewMessage(msg)
			if (!preview) continue

			const from = msg.key.participant || jid
			const user = from.split('@')[0]!
			const where = isJidGroup(jid) ? 'grupo' : 'privado'
			// a LID is an internal id, not a phone number: show the name and only the end of the id
			const who = from.endsWith('@lid')
				? `${msg.pushName || 'usuario'} (id …${user.slice(-4)})`
				: `${user}${msg.pushName ? ` · ${msg.pushName}` : ''}`
			line(msg.key.fromMe ? '📤' : '📩', `${where} · ${who}: ${preview}`)
		}
	})

	sock.ev.on('connection.update', ({ connection, lastDisconnect }: any) => {
		if (connection === 'open') line('🟢', 'Conectado a WhatsApp')
		if (connection === 'connecting') line('🔄', 'Conectando…')
		if (connection === 'close') {
			const code = lastDisconnect?.error?.output?.statusCode
			line('🔴', `Conexión cerrada${code ? ` (código ${code})` : ''}`)
		}
	})
}
