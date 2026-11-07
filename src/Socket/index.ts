import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { printBanner } from '../Utils/banner'
import { installConsoleFilter } from '../Utils/console-filter'
import { type HelperSocket, makeHelpers } from '../Utils/helpers'
import { makeSendQueue, type QueueSocket, type SendQueue } from '../Utils/send-queue'
import { makeCommunitiesSocket } from './communities'

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

	const sock = makeCommunitiesSocket(newConfig)
	const loose = sock as unknown as HelperSocket & QueueSocket

	// `Object.assign` (not a spread): the socket has getters such as `user` that must stay live
	const helpers = makeHelpers(loose, { logger: newConfig.logger, getMessage: newConfig.getMessage })

	// disabled by default: same shape, so `sock.queue` and `sock.sendMessageNow` always exist
	const sendQueue: SendQueue = newConfig.sendQueue
		? makeSendQueue(loose, typeof newConfig.sendQueue === 'object' ? newConfig.sendQueue : {})
		: { sendMessage: sock.sendMessage, sendMessageNow: sock.sendMessage, queue: { size: 0, clear: () => 0 } }

	return Object.assign(sock, helpers, sendQueue)
}

export default makeWASocket
