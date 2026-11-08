import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { printBanner } from '../Utils/banner'
import { installConsoleFilter } from '../Utils/console-filter'
import { makeGroupMetadataCache } from '../Utils/group-cache'
import { type HelperSocket, makeHelpers } from '../Utils/helpers'
import { makeMessageStore } from '../Utils/message-store'
import { makeSendQueue, type QueueSocket, type SendQueue } from '../Utils/send-queue'
import { makeCommunitiesSocket } from './communities'

const objectOrEmpty = <T extends object>(value: boolean | T | undefined): T =>
	typeof value === 'object' ? value : ({} as T)

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
	installConsoleFilter()
	printBanner()

	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	// a version pinned by the user wins, unless they explicitly asked for the live one
	if (config.version && config.syncWaWebVersion === undefined) {
		newConfig.syncWaWebVersion = false
	}

	// `version: undefined` (a version helper that failed) would wipe the fallback
	// the handshake needs, so put it back
	if (!newConfig.version) {
		newConfig.version = DEFAULT_CONNECTION_CONFIG.version
	}

	// recent messages: WhatsApp's delivery retries need `getMessage`, so keep them without any setup
	const store = newConfig.messageStore === false ? undefined : makeMessageStore(objectOrEmpty(newConfig.messageStore))
	if (store) {
		const userGetMessage = newConfig.getMessage
		newConfig.getMessage = async key => (await userGetMessage(key)) ?? store.get(key)
	}

	// group member lists: cached unless the user brought their own `cachedGroupMetadata`
	const groupCache =
		config.cachedGroupMetadata === undefined && newConfig.groupMetadataCache !== false
			? makeGroupMetadataCache(objectOrEmpty(newConfig.groupMetadataCache))
			: undefined
	if (groupCache) {
		newConfig.cachedGroupMetadata = async jid => groupCache.get(jid)
		newConfig.onGroupMetadata = (jid, metadata) => groupCache.set(jid, metadata)
	}

	const sock = makeCommunitiesSocket(newConfig)

	if (store) {
		sock.ev.on('messages.upsert', ({ messages }) => {
			for (const msg of messages) store.save(msg)
		})
	}

	if (groupCache) {
		// anything that changes a group makes its cached copy untrustworthy: forget it
		sock.ev.on('groups.upsert', groups => {
			for (const group of groups) groupCache.set(group.id, group)
		})
		sock.ev.on('groups.update', updates => {
			for (const update of updates) if (update.id) groupCache.delete(update.id)
		})
		sock.ev.on('group-participants.update', ({ id }) => {
			groupCache.delete(id)
		})
	}
	const loose = sock as unknown as HelperSocket & QueueSocket

	// `Object.assign` (not a spread): the socket has getters such as `user` that must stay live
	const helpers = makeHelpers(loose, { logger: newConfig.logger, getMessage: newConfig.getMessage })

	// disabled by default: same shape, so `sock.queue` and `sock.sendMessageNow` always exist
	const sendQueue: SendQueue = newConfig.sendQueue
		? makeSendQueue(loose, typeof newConfig.sendQueue === 'object' ? newConfig.sendQueue : {})
		: { sendMessage: sock.sendMessage, sendMessageNow: sock.sendMessage, queue: { size: 0, clear: () => 0 } }

	return Object.assign(sock, helpers, sendQueue, { messageStore: store, groupCache })
}

export default makeWASocket
