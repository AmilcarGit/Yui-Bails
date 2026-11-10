/**
 * Per-user cooldowns: "this user can run this action once every X ms".
 * `use` returns 0 when the action may go ahead (and starts the cooldown), or the milliseconds left.
 */
export const makeCooldowns = ({ now = Date.now }: { now?: () => number } = {}) => {
	const until = new Map<string, number>()

	const sweep = () => {
		const current = now()
		for (const [key, at] of until) {
			if (at <= current) until.delete(key)
		}
	}

	return {
		/** 0 = go ahead (the cooldown starts now); otherwise, ms still to wait. */
		use: (user: string, action: string, ms: number): number => {
			if (ms <= 0) return 0
			if (until.size > 5000) sweep()

			const key = `${user}\u0000${action}`
			const left = (until.get(key) ?? 0) - now()
			if (left > 0) return left

			until.set(key, now() + ms)
			return 0
		},
		/** ms left without starting anything */
		left: (user: string, action: string): number => Math.max(0, (until.get(`${user}\u0000${action}`) ?? 0) - now()),
		/** forget one cooldown (or all of a user's when `action` is omitted) */
		reset: (user: string, action?: string) => {
			if (action) until.delete(`${user}\u0000${action}`)
			else for (const key of [...until.keys()]) if (key.startsWith(`${user}\u0000`)) until.delete(key)
		},
		clear: () => until.clear()
	}
}

export type Cooldowns = ReturnType<typeof makeCooldowns>
