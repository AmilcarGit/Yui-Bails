import type { WAMessage, WAMessageKey, WAPresence } from '../Types'
import { isJidGroup, isJidStatusBroadcast } from '../WABinary'

export type AutoReadOptions = {
	/** mark messages from groups as read. Default true */
	groups?: boolean
	/** mark messages from private chats as read. Default true */
	private?: boolean
	/** wait this long before marking as read, in ms. Default 0 */
	delayMs?: number
}

export type AutomationConfig = {
	autoRead?: boolean | AutoReadOptions
	/** presence sent every time the connection opens: 'available' (online) or 'unavailable' (offline) */
	autoPresence?: 'available' | 'unavailable'
}

type Handler = (data: any) => void

export type AutomationSocket = {
	ev: { on: (event: string, handler: Handler) => void }
	readMessages: (keys: WAMessageKey[]) => Promise<void>
	sendPresenceUpdate: (type: WAPresence, toJid?: string) => Promise<void>
}

/**
 * Optional automatic behaviours: mark incoming messages as read and set the presence
 * (online / offline) when the connection opens. Both are off unless asked for.
 */
export const makeAutomation = (
	sock: AutomationSocket,
	config: AutomationConfig,
	options: { logger?: { debug: (obj: unknown, msg?: string) => void }; setTimer?: typeof setTimeout } = {}
) => {
	const setTimer = options.setTimer || setTimeout

	if (config.autoRead) {
		const read: AutoReadOptions = typeof config.autoRead === 'object' ? config.autoRead : {}
		const wantGroups = read.groups ?? true
		const wantPrivate = read.private ?? true

		const markRead = (key: WAMessageKey) => {
			sock.readMessages([key]).catch(error => options.logger?.debug({ error }, 'autoRead failed'))
		}

		sock.ev.on('messages.upsert', ({ messages, type }: { messages: WAMessage[]; type: string }) => {
			// `append` is history; only live messages are worth marking as read
			if (type !== 'notify') return

			for (const msg of messages) {
				const key = msg.key
				if (!key.remoteJid || key.fromMe || !key.id || isJidStatusBroadcast(key.remoteJid)) continue
				if (key.remoteJid.endsWith('@newsletter')) continue

				const inGroup = !!isJidGroup(key.remoteJid)
				if (inGroup ? !wantGroups : !wantPrivate) continue

				if (read.delayMs) setTimer(() => markRead(key), read.delayMs)
				else markRead(key)
			}
		})
	}

	if (config.autoPresence) {
		const presence = config.autoPresence
		sock.ev.on('connection.update', ({ connection }: { connection?: string }) => {
			if (connection === 'open') {
				sock.sendPresenceUpdate(presence).catch(error => options.logger?.debug({ error }, 'autoPresence failed'))
			}
		})
	}
}
