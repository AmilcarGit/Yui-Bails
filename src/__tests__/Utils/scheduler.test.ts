import { describe, expect, it, jest } from '@jest/globals'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeScheduler, nextCronTime, parseDuration } from '../../Utils/scheduler'

const setup = (options: Parameters<typeof makeScheduler>[1] = {}) => {
	let time = new Date(2026, 0, 5, 8, 0, 0).getTime() // Monday 5 Jan 2026, 08:00 local
	let pending: { fn: () => void; ms: number } | undefined
	const send = jest.fn(async (_jid: string, _content: unknown) => undefined)

	const scheduler = makeScheduler(send, {
		now: () => time,
		setTimer: (fn, ms) => (pending = { fn, ms }),
		clearTimer: () => (pending = undefined),
		...options
	})

	return {
		scheduler,
		send,
		timer: () => pending,
		advance: (ms: number) => void (time += ms),
		fire: async () => {
			const current = pending
			pending = undefined
			current?.fn()
			// let the async tick finish
			await new Promise(resolve => setImmediate(resolve))
		},
		time: () => time
	}
}

describe('parseDuration', () => {
	it('reads units and numbers', () => {
		expect(parseDuration('30s')).toBe(30_000)
		expect(parseDuration('15m')).toBe(900_000)
		expect(parseDuration('2h')).toBe(7_200_000)
		expect(parseDuration('1d')).toBe(86_400_000)
		expect(parseDuration(1500)).toBe(1500)
	})

	it('rejects nonsense', () => {
		expect(() => parseDuration('soon')).toThrow(/Invalid interval/)
		expect(() => parseDuration('0s')).toThrow(/greater than 0/)
		expect(() => parseDuration(-5)).toThrow(/greater than 0/)
	})
})

describe('nextCronTime', () => {
	const from = new Date(2026, 0, 5, 8, 0, 0).getTime() // Monday

	it('finds the next matching minute', () => {
		expect(new Date(nextCronTime('30 9 * * *', from))).toEqual(new Date(2026, 0, 5, 9, 30))
		// the current minute does not count
		expect(new Date(nextCronTime('0 8 * * *', from))).toEqual(new Date(2026, 0, 6, 8, 0))
	})

	it('supports steps, lists and ranges', () => {
		expect(new Date(nextCronTime('*/15 * * * *', from))).toEqual(new Date(2026, 0, 5, 8, 15))
		expect(new Date(nextCronTime('0 9,18 * * *', from))).toEqual(new Date(2026, 0, 5, 9, 0))
		expect(new Date(nextCronTime('0 9 * * 1-5', new Date(2026, 0, 9, 10, 0).getTime()))).toEqual(
			new Date(2026, 0, 12, 9, 0)
		)
	})

	it('supports weekdays (7 = Sunday) and months', () => {
		expect(new Date(nextCronTime('0 12 * * 7', from))).toEqual(new Date(2026, 0, 11, 12, 0))
		expect(new Date(nextCronTime('0 0 1 3 *', from))).toEqual(new Date(2026, 2, 1, 0, 0))
	})

	it('rejects invalid expressions', () => {
		expect(() => nextCronTime('* * * *', from)).toThrow(/5 fields/)
		expect(() => nextCronTime('61 * * * *', from)).toThrow(/Invalid cron/)
		expect(() => nextCronTime('*/0 * * * *', from)).toThrow(/step/)
		expect(() => nextCronTime('0 0 31 2 *', from)).toThrow(/never matches/)
	})
})

describe('makeScheduler', () => {
	it('sends a message after a delay, once', async () => {
		const { scheduler, send, timer, advance, fire } = setup()
		scheduler.start()
		scheduler.after('10m', 'a@s.whatsapp.net', { text: 'hola' })

		expect(timer()?.ms).toBe(600_000)
		advance(600_000)
		await fire()

		expect(send).toHaveBeenCalledTimes(1)
		expect(send).toHaveBeenCalledWith('a@s.whatsapp.net', { text: 'hola' })
		expect(scheduler.list()).toHaveLength(0)
		expect(timer()).toBeUndefined()
	})

	it('repeats with every(), and stops after `times`', async () => {
		const { scheduler, send, advance, fire } = setup()
		scheduler.start()
		scheduler.every('1h', 'g@g.us', { text: 'ping' }, { times: 2 })

		for (let i = 0; i < 3; i++) {
			advance(3_600_000)
			await fire()
		}

		expect(send).toHaveBeenCalledTimes(2)
		expect(scheduler.list()).toHaveLength(0)
	})

	it('schedules by cron and by date, soonest first', () => {
		const { scheduler, time } = setup()
		const late = scheduler.at(time() + 5000, 'a@s.whatsapp.net', { text: 'late' })
		const cron = scheduler.cron('30 8 * * *', 'a@s.whatsapp.net', { text: 'cron' })

		const [first, second] = scheduler.list()
		expect(first?.id).toBe(cron)
		expect(first?.at).toBe(new Date(2026, 0, 5, 8, 30).getTime())
		expect(second?.id).toBe(late)
		expect(() => scheduler.at('not a date', 'a@s.whatsapp.net', { text: 'x' })).toThrow(/Invalid date/)
	})

	it('does not send while stopped, and waits for start()', async () => {
		const { scheduler, send, timer } = setup()
		scheduler.after('1s', 'a@s.whatsapp.net', { text: 'x' })
		expect(timer()).toBeUndefined()

		scheduler.start()
		expect(timer()).toBeDefined()
		scheduler.stop()
		expect(timer()).toBeUndefined()
		expect(send).not.toHaveBeenCalled()
		expect(scheduler.list()).toHaveLength(1)
	})

	it('can cancel and clear', () => {
		const { scheduler } = setup()
		const id = scheduler.after('1h', 'a@s.whatsapp.net', { text: 'x' })
		scheduler.after('2h', 'a@s.whatsapp.net', { text: 'y' })

		expect(scheduler.cancel(id)).toBe(true)
		expect(scheduler.cancel(id)).toBe(false)
		scheduler.clear()
		expect(scheduler.list()).toHaveLength(0)
	})

	it('retries a failed send 30 s later and gives up after maxAttempts', async () => {
		const { scheduler, send, advance, fire } = setup({ maxAttempts: 2 })
		send.mockRejectedValue(new Error('offline'))
		scheduler.start()
		scheduler.after('1s', 'a@s.whatsapp.net', { text: 'x' })

		advance(1000)
		await fire()
		expect(scheduler.list()).toHaveLength(1)

		advance(30_000)
		await fire()
		expect(send).toHaveBeenCalledTimes(2)
		expect(scheduler.list()).toHaveLength(0)
	})

	it('rejects content that cannot be saved as JSON', () => {
		const { scheduler } = setup()
		expect(() => scheduler.after('1s', 'a@s.whatsapp.net', { image: Buffer.from('x') })).toThrow(/plain JSON/)
		expect(() => scheduler.after('1s', 'a@s.whatsapp.net', { image: { url: 'https://x.test/a.png' } })).not.toThrow()
	})

	it('keeps messages in a file and loads them again', async () => {
		const file = join(mkdtempSync(join(tmpdir(), 'yui-sched-')), 'scheduled.json')
		const first = setup({ file })
		const id = first.scheduler.after('1h', 'a@s.whatsapp.net', { text: 'persisto' })
		await first.scheduler.flush()

		expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1)

		const second = setup({ file })
		expect(second.scheduler.list().map(job => job.id)).toEqual([id])
	})

	it('on start: drops one-time messages that are too late, sends the slightly late ones', async () => {
		const file = join(mkdtempSync(join(tmpdir(), 'yui-sched-')), 'scheduled.json')
		const first = setup({ file })
		first.scheduler.at(first.time() + 1000, 'a@s.whatsapp.net', { text: 'tarde' })
		first.scheduler.at(first.time() + 2000, 'a@s.whatsapp.net', { text: 'casi' })
		await first.scheduler.flush()

		const second = setup({ file, catchUpMs: 60_000 })
		const [late, almost] = second.scheduler.list()
		// first one is 10 min late, second one too: move the clock so only one is within the limit
		second.advance(1000 + 60_000 + 500)
		second.scheduler.start()

		expect(late).toBeDefined()
		expect(almost).toBeDefined()
		expect(second.scheduler.list().map(job => (job.content as { text: string }).text)).toEqual(['casi'])
		await second.fire()
		expect(second.send).toHaveBeenCalledTimes(1)
		expect(second.send).toHaveBeenCalledWith('a@s.whatsapp.net', { text: 'casi' })
	})

	it('a corrupt file starts empty instead of crashing', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yui-sched-'))
		const file = join(dir, 'bad.json')
		await import('fs').then(fs => fs.writeFileSync(file, '{not json'))

		expect(setup({ file }).scheduler.list()).toEqual([])
	})
})
