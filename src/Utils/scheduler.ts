import { Boom } from '@hapi/boom'
import { promises as fs, readFileSync } from 'fs'
import type { MiscMessageGenerationOptions } from '../Types'

type Content = Record<string, unknown>

export type ScheduledJob = {
	id: string
	jid: string
	content: Content
	kind: 'once' | 'every' | 'cron'
	/** next time to send, in ms since 1970 */
	at: number
	/** repeat interval (`every`) */
	everyMs?: number
	/** 5-field cron expression (`cron`) */
	cron?: string
	/** how many times it has been sent */
	runs: number
	/** stop after this many sends (repeating jobs) */
	times?: number
	/** failed sends in a row */
	failures: number
}

export type SchedulerOptions = {
	/** JSON file where the pending messages are kept, so they survive a restart. Without it they live in memory only */
	file?: string
	/** a one-time message that should have gone out while the bot was off is still sent if it is at most this late (ms). Default 5 min */
	catchUpMs?: number
	/** tries for one send before giving up on that run. Default 3 (30 s apart) */
	maxAttempts?: number
	logger?: { warn: (obj: unknown, msg?: string) => void; debug: (obj: unknown, msg?: string) => void }
	now?: () => number
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (timer: unknown) => void
}

type SendFn = (jid: string, content: any, options?: MiscMessageGenerationOptions) => Promise<unknown> | unknown

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
const MAX_TIMER = 2 ** 31 - 1
const RETRY_MS = 30_000

/** `'30s'`, `'15m'`, `'2h'`, `'1d'` or a number of ms */
export const parseDuration = (value: string | number): number => {
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0)
			throw new Boom('The interval must be greater than 0', { statusCode: 400 })
		return value
	}

	const match = /^(\d+)\s*([smhd])$/i.exec(String(value).trim())
	if (!match) throw new Boom(`Invalid interval "${value}": use 30s, 15m, 2h or 1d`, { statusCode: 400 })

	const ms = Number(match[1]) * UNITS[match[2]!.toLowerCase()]!
	if (ms <= 0) throw new Boom('The interval must be greater than 0', { statusCode: 400 })
	return ms
}

const FIELD_RANGES: Array<[number, number]> = [
	[0, 59], // minute
	[0, 23], // hour
	[1, 31], // day of the month
	[1, 12], // month
	[0, 6] // day of the week (0 = Sunday)
]

const parseField = (field: string, [min, max]: [number, number], isWeekday: boolean): Set<number> => {
	const values = new Set<number>()

	for (const part of field.split(',')) {
		const [range = '', stepText] = part.split('/')
		const step = stepText === undefined ? 1 : Number(stepText)
		if (!Number.isInteger(step) || step < 1) throw new Boom(`Invalid cron step in "${field}"`, { statusCode: 400 })

		let from = min
		let to = max
		if (range !== '*') {
			const [startText = '', endText] = range.split('-')
			from = Number(startText)
			to = endText === undefined ? (stepText === undefined ? from : max) : Number(endText)
		}

		if (isWeekday) {
			// 7 is also Sunday
			if (from === 7) from = 0
			if (to === 7 && from !== 0) to = 6
		}

		if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
			throw new Boom(`Invalid cron field "${field}"`, { statusCode: 400 })
		}

		for (let value = from; value <= to; value += step) values.add(value)
	}

	return values
}

type CronSets = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]

const parseCron = (expression: string): CronSets => {
	const fields = expression.trim().split(/\s+/)
	if (fields.length !== 5) {
		throw new Boom('A cron expression has 5 fields: minute hour day month weekday (e.g. "0 9 * * 1-5")', {
			statusCode: 400
		})
	}

	return fields.map((field, index) => parseField(field, FIELD_RANGES[index]!, index === 4)) as CronSets
}

/**
 * Next time (ms) after `from` that matches a 5-field cron expression, in the local time of the
 * process. Supports `*`, lists (`1,15`), ranges (`1-5`) and steps (`*\/10`, `8-18/2`).
 */
export const nextCronTime = (expression: string, from: number): number => {
	const [minutes, hours, days, months, weekdays] = parseCron(expression)
	const date = new Date(from)
	date.setSeconds(0, 0)
	date.setMinutes(date.getMinutes() + 1)

	// a few years is plenty: no valid expression takes longer than 4 years (29 Feb)
	for (let guard = 0; guard < 400_000; guard++) {
		if (!months.has(date.getMonth() + 1)) {
			date.setMonth(date.getMonth() + 1, 1)
			date.setHours(0, 0, 0, 0)
		} else if (!days.has(date.getDate()) || !weekdays.has(date.getDay())) {
			date.setDate(date.getDate() + 1)
			date.setHours(0, 0, 0, 0)
		} else if (!hours.has(date.getHours())) {
			date.setHours(date.getHours() + 1, 0, 0, 0)
		} else if (!minutes.has(date.getMinutes())) {
			date.setMinutes(date.getMinutes() + 1, 0, 0)
		} else {
			return date.getTime()
		}
	}

	throw new Boom(`The cron expression "${expression}" never matches`, { statusCode: 400 })
}

/** rejects what cannot be saved in a JSON file (buffers, streams, functions) */
const assertSerializable = (content: unknown) => {
	JSON.stringify(content, (_key, value) => {
		if (typeof value === 'function' || Buffer.isBuffer(value) || value instanceof Uint8Array) {
			throw new Boom('Scheduled content must be plain JSON: use { url } for media, not buffers or streams', {
				statusCode: 400
			})
		}

		return value
	})
}

/**
 * Messages for later: once at a date, every so often, or by a cron expression. With `file` they
 * survive restarts. The timer only runs between `start()` and `stop()` (the socket does that when it
 * connects and disconnects), so nothing is sent while the bot is offline.
 */
export const makeScheduler = (send: SendFn, options: SchedulerOptions = {}) => {
	const now = options.now || Date.now
	const setTimer = options.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms))
	const clearTimer = options.clearTimer || ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
	const catchUpMs = options.catchUpMs ?? 5 * 60_000
	const maxAttempts = options.maxAttempts ?? 3

	const jobs = new Map<string, ScheduledJob>()
	let timer: unknown
	let running = false
	let counter = 0
	let saving: Promise<void> = Promise.resolve()

	const save = () => {
		if (!options.file) return
		const file = options.file
		const data = JSON.stringify([...jobs.values()], null, 2)
		// one write at a time, through a temp file, so a crash never leaves half a file
		saving = saving
			.then(async () => {
				await fs.writeFile(`${file}.tmp`, data)
				await fs.rename(`${file}.tmp`, file)
			})
			.catch(error => options.logger?.warn({ error }, 'could not save the scheduled messages'))
	}

	if (options.file) {
		try {
			for (const job of JSON.parse(readFileSync(options.file, 'utf8')) as ScheduledJob[]) {
				if (job?.id && job.jid && job.content && typeof job.at === 'number') jobs.set(job.id, job)
			}
		} catch {
			// no file yet, or it is not valid: start empty
		}
	}

	const newId = () =>
		`s${now().toString(36)}${(++counter).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

	const nextRun = (job: ScheduledJob, from: number): number | undefined => {
		if (job.kind === 'every') return from + job.everyMs!
		if (job.kind === 'cron') return nextCronTime(job.cron!, from)
		return undefined
	}

	const arm = () => {
		if (timer !== undefined) clearTimer(timer)
		timer = undefined
		if (!running || !jobs.size) return

		const soonest = Math.min(...[...jobs.values()].map(job => job.at))
		timer = setTimer(() => void tick(), Math.min(MAX_TIMER, Math.max(0, soonest - now())))
	}

	const runJob = async (job: ScheduledJob) => {
		try {
			await send(job.jid, job.content)
			job.failures = 0
			job.runs += 1
		} catch (error) {
			job.failures += 1
			options.logger?.warn({ error, id: job.id }, 'a scheduled message could not be sent')

			if (job.failures < maxAttempts) {
				job.at = now() + RETRY_MS
				return
			}

			job.failures = 0
		}

		const next = job.times !== undefined && job.runs >= job.times ? undefined : nextRun(job, now())
		if (next === undefined) jobs.delete(job.id)
		else job.at = next
	}

	async function tick() {
		timer = undefined
		const due = [...jobs.values()].filter(job => job.at <= now())

		for (const job of due) await runJob(job)

		save()
		arm()
	}

	const add = (job: Omit<ScheduledJob, 'id' | 'runs' | 'failures'>): string => {
		assertSerializable(job.content)
		const id = newId()
		jobs.set(id, { ...job, id, runs: 0, failures: 0 })
		save()
		arm()
		return id
	}

	return {
		/** sends once, at a date (`Date`, ms since 1970 or an ISO text) */
		at: (when: Date | number | string, jid: string, content: Content): string => {
			const at = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when)
			if (!Number.isFinite(at)) throw new Boom(`Invalid date "${String(when)}"`, { statusCode: 400 })
			return add({ jid, content, kind: 'once', at })
		},

		/** sends after a wait: `'30s'`, `'15m'`, `'2h'`, `'1d'` or ms */
		after: (delay: string | number, jid: string, content: Content): string =>
			add({ jid, content, kind: 'once', at: now() + parseDuration(delay) }),

		/** sends every so often: `'30m'`, `'2h'`, `'1d'`. `times` stops it after that many sends */
		every: (interval: string | number, jid: string, content: Content, extra: { times?: number } = {}): string => {
			const everyMs = parseDuration(interval)
			return add({ jid, content, kind: 'every', everyMs, at: now() + everyMs, times: extra.times })
		},

		/** sends by a cron expression ("0 9 * * 1-5" = weekdays at 9:00, local time) */
		cron: (expression: string, jid: string, content: Content, extra: { times?: number } = {}): string =>
			add({ jid, content, kind: 'cron', cron: expression, at: nextCronTime(expression, now()), times: extra.times }),

		/** what is waiting, soonest first */
		list: (): ScheduledJob[] => [...jobs.values()].sort((a, b) => a.at - b.at),

		cancel: (id: string): boolean => {
			const removed = jobs.delete(id)
			if (removed) {
				save()
				arm()
			}

			return removed
		},

		clear: () => {
			jobs.clear()
			save()
			arm()
		},

		/** starts the timer (called when the account connects). Late one-time messages are sent or dropped first */
		start: () => {
			running = true

			for (const job of [...jobs.values()]) {
				if (job.at > now()) continue

				if (job.kind === 'once') {
					if (now() - job.at > catchUpMs) {
						options.logger?.warn({ id: job.id }, 'a scheduled message was too late and was dropped')
						jobs.delete(job.id)
					}
				} else {
					// repeating jobs just wait for their next turn
					job.at = nextRun(job, now()) ?? job.at
				}
			}

			save()
			arm()
		},

		/** stops the timer (called when the connection drops). Nothing is lost */
		stop: () => {
			running = false
			if (timer !== undefined) clearTimer(timer)
			timer = undefined
		},

		/** waits until the file is written (useful in tests and before exiting) */
		flush: () => saving
	}
}

export type Scheduler = ReturnType<typeof makeScheduler>
