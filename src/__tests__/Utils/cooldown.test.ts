import { describe, expect, it } from '@jest/globals'
import { makeCooldowns } from '../../Utils/cooldown'

describe('makeCooldowns', () => {
	it('lets the first use through and makes the next one wait', () => {
		let time = 1000
		const cooldowns = makeCooldowns({ now: () => time })

		expect(cooldowns.use('u1', 'ping', 5000)).toBe(0)
		time = 3000
		expect(cooldowns.use('u1', 'ping', 5000)).toBe(3000)
		time = 6000
		expect(cooldowns.use('u1', 'ping', 5000)).toBe(0)
	})

	it('is per user and per action', () => {
		const cooldowns = makeCooldowns({ now: () => 0 })
		cooldowns.use('u1', 'ping', 5000)

		expect(cooldowns.use('u2', 'ping', 5000)).toBe(0)
		expect(cooldowns.use('u1', 'menu', 5000)).toBe(0)
		expect(cooldowns.left('u1', 'ping')).toBe(5000)
	})

	it('does nothing with a cooldown of 0 and can be reset', () => {
		const cooldowns = makeCooldowns({ now: () => 0 })
		expect(cooldowns.use('u1', 'a', 0)).toBe(0)

		cooldowns.use('u1', 'a', 1000)
		cooldowns.use('u1', 'b', 1000)
		cooldowns.reset('u1', 'a')
		expect(cooldowns.left('u1', 'a')).toBe(0)
		expect(cooldowns.left('u1', 'b')).toBe(1000)

		cooldowns.reset('u1')
		expect(cooldowns.left('u1', 'b')).toBe(0)
	})
})
