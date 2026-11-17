import { Boom } from '@hapi/boom'
import type { MiscMessageGenerationOptions, WAMessage, WAMessageKey } from '../Types'
import { parseDuration } from './scheduler'

type PollVotes = Array<{ name: string; voters: string[] }>

export type TimedPollDeps = {
	sendPoll: (
		jid: string,
		name: string,
		values: string[],
		poll?: { selectableCount?: number },
		options?: MiscMessageGenerationOptions
	) => Promise<WAMessage | undefined>
	getPollVotes: (pollKey: WAMessageKey | string) => { pollName: string; votes: PollVotes } | undefined
	sendMessage: (jid: string, content: any, options?: MiscMessageGenerationOptions) => Promise<unknown>
	logger?: { warn: (...args: any[]) => void }
	/** replaceable for tests */
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (timer: unknown) => void
	now?: () => number
}

export type TimedPollOptions = {
	/** how long the poll stays open: `'10m'`, `'2h'`, `'1d'`, ms, or the date it closes */
	closeAfter: string | number | Date
	/** 1 by default */
	selectableCount?: number
	/** show who voted what in the result. Default true; `false` shows only the counts */
	showVoters?: boolean
	/** called with the final results when the poll closes */
	onClose?: (result: TimedPollResult) => void | Promise<void>
}

export type TimedPollResult = {
	pollKey: WAMessageKey
	pollName: string
	total: number
	options: Array<{ name: string; votes: number; percent: number; voters: string[] }>
	/** the option(s) with the most votes (several when tied, none when nobody voted) */
	winners: string[]
}

/** longest wait of one timer (about 24 days); longer polls are not supported */
const MAX_MS = 2 ** 31 - 1
const MIN_MS = 5_000

const phone = (jid: string) => `@${jid.split('@')[0]!.split(':')[0]}`

export const summarizeVotes = (pollKey: WAMessageKey, pollName: string, votes: PollVotes): TimedPollResult => {
	const unique = (voters: string[]) => [...new Set(voters)]
	const options = votes.map(option => ({
		name: option.name,
		voters: unique(option.voters),
		votes: unique(option.voters).length
	}))
	const everyone = new Set(options.flatMap(option => option.voters))
	const total = everyone.size
	const best = Math.max(0, ...options.map(option => option.votes))

	return {
		pollKey,
		pollName,
		total,
		options: options.map(option => ({
			...option,
			percent: total ? Math.round((option.votes / total) * 100) : 0
		})),
		winners: best ? options.filter(option => option.votes === best).map(option => option.name) : []
	}
}

/** the text sent when a poll closes */
export const formatResult = (result: TimedPollResult, showVoters: boolean) => {
	const lines = result.options.map(option => {
		const bar = '█'.repeat(Math.round(option.percent / 10)).padEnd(10, '░')
		const voters = showVoters && option.voters.length ? `\n   ${option.voters.map(phone).join(' ')}` : ''
		return `▢ *${option.name}*\n   ${bar} ${option.votes} (${option.percent}%)${voters}`
	})

	const verdict = !result.total
		? 'Nadie votó.'
		: result.winners.length > 1
			? `🤝 Empate: ${result.winners.join(', ')}`
			: `🏆 Ganó: *${result.winners[0]}*`

	return `📊 *Encuesta cerrada*\n${result.pollName}\n\n${lines.join('\n\n')}\n\n${verdict}\n👥 ${result.total} voto${result.total === 1 ? '' : 's'}`
}

/**
 * A poll that closes by itself: at the end time the bot sends the result (with or without names).
 * WhatsApp has no real "closed" state for bots, so votes sent later are simply not counted in the
 * result. The timer lives in memory: if the bot restarts before the end, nothing is sent.
 */
export const makeTimedPolls = (deps: TimedPollDeps) => {
	const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms))
	const clearTimer = deps.clearTimer || (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
	const now = deps.now || Date.now
	const open = new Map<string, { jid: string; name: string; closesAt: number; timer: unknown }>()

	const close = async (id: string, showVoters: boolean, onClose: TimedPollOptions['onClose'], message: WAMessage) => {
		const entry = open.get(id)
		if (!entry) return
		open.delete(id)

		try {
			const found = deps.getPollVotes(message.key)
			const result = summarizeVotes(message.key, found?.pollName || entry.name, found?.votes || [])
			await deps.sendMessage(entry.jid, { text: formatResult(result, showVoters) }, { quoted: message })
			await onClose?.(result)
		} catch (error) {
			deps.logger?.warn({ error }, 'could not send the result of a timed poll')
		}
	}

	return {
		/** sends the poll and schedules its result. Resolves the sent message, when it closes and `cancel()` */
		sendTimedPoll: async (
			jid: string,
			name: string,
			values: string[],
			{ closeAfter, selectableCount = 1, showVoters = true, onClose }: TimedPollOptions,
			options?: MiscMessageGenerationOptions
		) => {
			const ms = closeAfter instanceof Date ? closeAfter.getTime() - now() : parseDuration(closeAfter)
			if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
				throw new Boom('closeAfter must be between 5 seconds and 24 days', { statusCode: 400 })
			}

			const message = await deps.sendPoll(jid, name, values, { selectableCount }, options)
			if (!message?.key?.id) throw new Boom('WhatsApp did not accept the poll', { statusCode: 500 })

			const id = message.key.id
			const timer = setTimer(() => void close(id, showVoters, onClose, message), ms)
			;(timer as { unref?: () => void } | undefined)?.unref?.()
			open.set(id, { jid, name, closesAt: now() + ms, timer })

			return {
				message,
				closesAt: new Date(now() + ms),
				cancel: () => {
					const entry = open.get(id)
					if (entry) clearTimer(entry.timer)
					return open.delete(id)
				}
			}
		},

		/** polls still waiting to close */
		openPolls: () =>
			[...open.entries()].map(([id, entry]) => ({
				id,
				jid: entry.jid,
				name: entry.name,
				closesAt: new Date(entry.closesAt)
			}))
	}
}

export type TimedPolls = ReturnType<typeof makeTimedPolls>
