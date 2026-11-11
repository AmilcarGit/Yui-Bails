import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { type AutomationSocket, makeAutomation } from '../Utils/automation'
import { printBanner } from '../Utils/banner'
import { type CommandsSocket, makeCommands } from '../Utils/commands'
import { installConsoleFilter } from '../Utils/console-filter'
import { makeGroupMetadataCache } from '../Utils/group-cache'
import { makeGroupFetcher } from '../Utils/group-fetch'
import { type GroupToolsSocket, makeGroupTools } from '../Utils/group-tools'
import { type HelperSocket, makeHelpers } from '../Utils/helpers'
import { makeInsights } from '../Utils/insights'
import { type InteractiveSocket, makeInteractive } from '../Utils/interactive'
import { withAutoMentions } from '../Utils/mentions'
import { makeMessageStore } from '../Utils/message-store'
import { attachPrettyEvents } from '../Utils/pretty-log'
import { makeReplyTools, type ReplySocket } from '../Utils/replies'
import { makeScheduler } from '../Utils/scheduler'
import { makeSendExtras } from '../Utils/send-extras'
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

	// `sock.groupMetadata`: cache first, one request per group at a time, waits when WhatsApp rate-limits
	const rawGroupMetadata = sock.groupMetadata
	const groupMetadata = makeGroupFetcher(rawGroupMetadata, groupCache)
	sock.groupMetadata = groupMetadata

	const loose = sock as unknown as HelperSocket & QueueSocket

	// optional: mark messages as read and set the presence by itself
	makeAutomation(sock as unknown as AutomationSocket, newConfig, { logger: newConfig.logger })
	if (newConfig.prettyLogs) attachPrettyEvents(sock as unknown as Parameters<typeof attachPrettyEvents>[0])

	// `Object.assign` (not a spread): the socket has getters such as `user` that must stay live
	const helpers = makeHelpers(loose, { logger: newConfig.logger, getMessage: newConfig.getMessage })

	// disabled by default: same shape, so `sock.queue` and `sock.sendMessageNow` always exist
	const sendQueue: SendQueue = newConfig.sendQueue
		? makeSendQueue(loose, typeof newConfig.sendQueue === 'object' ? newConfig.sendQueue : {})
		: { sendMessage: sock.sendMessage, sendMessageNow: sock.sendMessage, queue: { size: 0, clear: () => 0 } }

	// onButton / onList / onReply / awaitReply use the (already extended) socket's getSender
	const replies = makeReplyTools(Object.assign(loose, helpers) as unknown as ReplySocket, newConfig.logger)

	// real numbers: counters, health with a measured ping, and the `message.status` event
	const insights = makeInsights(loose as never, { queueSize: () => sendQueue.queue.size })

	// admin checks and moderation shortcuts that understand both phone numbers and LIDs
	const groups = makeGroupTools(loose as unknown as GroupToolsSocket, {
		cache: groupCache,
		getSender: helpers.getSender
	})

	// confirmations, pages, nested menus, guarded and repeatable buttons
	const interactive = makeInteractive(
		{
			sendMessage: (...args) => (sock.sendMessage as InteractiveSocket['sendMessage'])(...args),
			sendButtons: (...args) => helpers.sendButtons(...args),
			disableButtons: msg => helpers.disableButtons(msg),
			getSender: msg => helpers.getSender(msg),
			onReply: (matcher, run) => replies.onReply(matcher, run),
			isAdmin: (jid, who) => groups.isAdmin(jid, who)
		},
		{ logger: newConfig.logger }
	)

	// commands with prefix, roles and cooldown; messages for later
	const commands = makeCommands(
		{
			ev: sock.ev as unknown as CommandsSocket['ev'],
			getSender: msg => helpers.getSender(msg),
			sendMessage: (...args) => (sock.sendMessage as CommandsSocket['sendMessage'])(...args),
			isAdmin: (jid, who) => groups.isAdmin(jid, who)
		},
		newConfig.commands
	)

	const scheduler = makeScheduler((jid, content, options) => sock.sendMessage(jid, content as any, options), {
		file: newConfig.schedulerFile,
		logger: newConfig.logger
	})

	// contacts, location, album, event and long text; they go through the (queued) `sock.sendMessage`
	const extras = makeSendExtras(
		{
			sendMessage: (jid, content, options) => (sock as any).sendMessage(jid, content, options),
			relayMessage: (jid, message, options) => sock.relayMessage(jid, message, options)
		},
		{
			sendPoll: (...args) => (sock as any).sendPoll(...args),
			awaitReply: (...args) => replies.awaitReply(...args)
		}
	)

	// messages for later only go out while the account is connected
	sock.ev.on('connection.update', ({ connection }) => {
		if (connection === 'open') scheduler.start()
		else if (connection === 'close') scheduler.stop()
	})

	// every send: `@number` in the text becomes a mention, and the result is counted
	const decorate = (send: typeof sock.sendMessage): typeof sock.sendMessage =>
		insights.wrapSend((jid, content, options) =>
			send(jid, newConfig.autoMentions === false ? content : withAutoMentions(content), options)
		) as typeof sock.sendMessage

	// at most three sources: `Object.assign` loses its types with more
	return Object.assign(sock, helpers, replies, {
		...sendQueue,
		getStats: insights.getStats,
		resetStats: insights.resetStats,
		getMessageStatus: insights.getMessageStatus,
		health: insights.health,
		...groups,
		...interactive,
		...extras,
		commands,
		schedule: scheduler,
		cooldown: commands.cooldowns.use,
		sendMessage: decorate(sendQueue.sendMessage as typeof sock.sendMessage),
		sendMessageNow: decorate(sendQueue.sendMessageNow as typeof sock.sendMessage),
		messageStore: store,
		groupCache
	})
}

export default makeWASocket
