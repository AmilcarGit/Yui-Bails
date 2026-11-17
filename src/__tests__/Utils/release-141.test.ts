import { Boom } from '@hapi/boom'
import { describe, expect, it, jest } from '@jest/globals'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { gzipSync } from 'zlib'
import type { WAMessage } from '../../Types'
import { makeSendExtras } from '../../Utils/send-extras'
import { withSendRetry } from '../../Utils/send-retry'
import { backupSession, restoreSession } from '../../Utils/session-backup'
import { formatResult, makeTimedPolls, summarizeVotes } from '../../Utils/timed-poll'

const GROUP = '1203@g.us'
const A = '51900000001@s.whatsapp.net'
const B = '51900000002@s.whatsapp.net'
const C = '51900000003@s.whatsapp.net'

describe('withSendRetry', () => {
	const timedOut = () => new Boom('Timed Out', { statusCode: 408 })

	it('tries again with the SAME message id and growing waits', async () => {
		const ids: string[] = []
		const send = jest
			.fn<(jid: string, content: unknown, options?: any) => Promise<string>>()
			.mockImplementationOnce(async (_jid, _content, options) => {
				ids.push(options.messageId)
				throw timedOut()
			})
			.mockImplementationOnce(async (_jid, _content, options) => {
				ids.push(options.messageId)
				throw timedOut()
			})
			.mockImplementationOnce(async (_jid, _content, options) => {
				ids.push(options.messageId)
				return 'ok'
			})
		const waits: number[] = []
		const retrying = withSendRetry(send, { baseDelayMs: 100, sleep: async ms => void waits.push(ms) })

		await expect(retrying(GROUP, { text: 'x' })).resolves.toBe('ok')
		expect(waits).toEqual([100, 200])
		expect(new Set(ids).size).toBe(1)
		expect(ids[0]).toMatch(/^[0-9A-F]+$/)
	})

	it('keeps the id the caller chose', async () => {
		const send = jest.fn<(jid: string, content: unknown, options?: any) => Promise<string>>(async () => 'ok')
		await withSendRetry(send, {})(GROUP, { text: 'x' }, { messageId: 'MINE' })
		expect(send.mock.calls[0]![2].messageId).toBe('MINE')
	})

	it('gives up after the retries and never retries real errors', async () => {
		const failing = jest.fn<(jid: string, content: unknown, options?: any) => Promise<string>>(async () => {
			throw timedOut()
		})
		await expect(withSendRetry(failing, { retries: 1, sleep: async () => undefined })(GROUP, {})).rejects.toThrow(
			'Timed Out'
		)
		expect(failing).toHaveBeenCalledTimes(2)

		const forbidden = jest.fn<(jid: string, content: unknown, options?: any) => Promise<string>>(async () => {
			throw new Boom('forbidden', { statusCode: 403 })
		})
		await expect(withSendRetry(forbidden, { sleep: async () => undefined })(GROUP, {})).rejects.toThrow('forbidden')
		expect(forbidden).toHaveBeenCalledTimes(1)
	})

	it('reports each retry', async () => {
		const onRetry = jest.fn()
		let first = true
		const send = jest.fn<(jid: string, content: unknown, options?: any) => Promise<string>>(async () => {
			if (first) {
				first = false
				throw timedOut()
			}

			return 'ok'
		})
		await withSendRetry(send, { sleep: async () => undefined, onRetry })(GROUP, {})
		expect(onRetry).toHaveBeenCalledWith(expect.any(Boom), 1)
	})
})

describe('timed polls', () => {
	const votesOf = (...options: Array<[string, string[]]>) => options.map(([name, voters]) => ({ name, voters }))

	it('summarizes counts, percentages and winners (a voter is counted once)', () => {
		const result = summarizeVotes({ id: 'P' }, 'Pizza', votesOf(['Sí', [A, B, A]], ['No', [C]], ['Tal vez', []]))
		expect(result.total).toBe(3)
		expect(result.options.map(option => [option.name, option.votes, option.percent])).toEqual([
			['Sí', 2, 67],
			['No', 1, 33],
			['Tal vez', 0, 0]
		])
		expect(result.winners).toEqual(['Sí'])
		expect(summarizeVotes({ id: 'P' }, 'x', votesOf(['a', [A]], ['b', [B]])).winners).toEqual(['a', 'b'])
		expect(summarizeVotes({ id: 'P' }, 'x', votesOf(['a', []])).winners).toEqual([])
	})

	it('formats the result with or without names', () => {
		const result = summarizeVotes({ id: 'P' }, 'Pizza', votesOf(['Sí', [A]], ['No', []]))
		expect(formatResult(result, true)).toContain('@51900000001')
		expect(formatResult(result, true)).toContain('🏆 Ganó: *Sí*')
		expect(formatResult(result, false)).not.toContain('@51900000001')
		expect(formatResult(summarizeVotes({ id: 'P' }, 'x', votesOf(['a', []])), false)).toContain('Nadie votó.')
		expect(formatResult(summarizeVotes({ id: 'P' }, 'x', votesOf(['a', [A]], ['b', [B]])), false)).toContain(
			'🤝 Empate: a, b'
		)
	})

	const setup = () => {
		let fire: (() => void) | undefined
		let cleared = 0
		const sent: Array<{ jid: string; content: any; options: any }> = []
		const message = { key: { remoteJid: GROUP, id: 'POLL1', fromMe: true } } as unknown as WAMessage
		const polls = makeTimedPolls({
			sendPoll: async () => message,
			getPollVotes: () => ({ pollName: 'Pizza', votes: votesOf(['Sí', [A, B]], ['No', [C]]) }),
			sendMessage: async (jid, content, options) => void sent.push({ jid, content, options }),
			setTimer: fn => {
				fire = fn
				return 1
			},
			clearTimer: () => void cleared++,
			now: () => 1_000_000
		})
		return {
			polls,
			sent,
			message,
			fire: async () => {
				fire?.()
				await new Promise(resolve => setImmediate(resolve))
			},
			cleared: () => cleared
		}
	}

	it('sends the result, quoting the poll, when time is up', async () => {
		const { polls, sent, message, fire } = setup()
		const onClose = jest.fn<(result: any) => void>()
		const timed = await polls.sendTimedPoll(GROUP, 'Pizza', ['Sí', 'No'], {
			closeAfter: '10m',
			showVoters: false,
			onClose
		})

		expect(timed.closesAt).toEqual(new Date(1_000_000 + 600_000))
		expect(polls.openPolls()).toHaveLength(1)

		await fire()
		expect(sent).toHaveLength(1)
		expect(sent[0]!.content.text).toContain('Encuesta cerrada')
		expect(sent[0]!.content.text).toContain('🏆 Ganó: *Sí*')
		expect(sent[0]!.content.text).not.toContain('@5190')
		expect(sent[0]!.options.quoted).toBe(message)
		expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ total: 3, winners: ['Sí'] }))
		expect(polls.openPolls()).toHaveLength(0)
	})

	it('can be cancelled, and validates the time', async () => {
		const { polls, sent, fire, cleared } = setup()
		const timed = await polls.sendTimedPoll(GROUP, 'x', ['a', 'b'], { closeAfter: 60_000 })
		expect(timed.cancel()).toBe(true)
		expect(cleared()).toBe(1)
		await fire()
		expect(sent).toHaveLength(0)

		await expect(polls.sendTimedPoll(GROUP, 'x', ['a', 'b'], { closeAfter: '1s' })).rejects.toThrow(/between 5 seconds/)
		await expect(polls.sendTimedPoll(GROUP, 'x', ['a', 'b'], { closeAfter: '30d' })).rejects.toThrow(
			/between 5 seconds/
		)
		await expect(polls.sendTimedPoll(GROUP, 'x', ['a', 'b'], { closeAfter: 'soon' })).rejects.toThrow()
		const date = await polls.sendTimedPoll(GROUP, 'x', ['a', 'b'], { closeAfter: new Date(1_000_000 + 120_000) })
		expect(date.closesAt).toEqual(new Date(1_120_000))
	})
})

describe('session backup', () => {
	const makeAuth = async () => {
		const dir = await mkdtemp(join(tmpdir(), 'yui-auth-'))
		await writeFile(join(dir, 'creds.json'), '{"me":1}')
		await writeFile(join(dir, 'pre-key-1.json'), '{"k":1}')
		return dir
	}

	it('saves the login in one file and restores it elsewhere', async () => {
		const auth = await makeAuth()
		const out = join(await mkdtemp(join(tmpdir(), 'yui-bak-')), 'sub', 'copia.yuibackup')

		const saved = await backupSession(auth, out)
		expect(saved.files).toBe(2)

		const target = join(await mkdtemp(join(tmpdir(), 'yui-res-')), 'session')
		const restored = await restoreSession(out, target)
		expect(restored.files).toBe(2)
		expect(await readFile(join(target, 'creds.json'), 'utf8')).toBe('{"me":1}')
		expect((await readdir(target)).sort()).toEqual(['creds.json', 'pre-key-1.json'])
	})

	it('refuses to replace an existing login unless asked', async () => {
		const auth = await makeAuth()
		const out = join(await mkdtemp(join(tmpdir(), 'yui-bak-')), 'b.yuibackup')
		await backupSession(auth, out)

		await expect(restoreSession(out, auth)).rejects.toThrow(/already has a login/)
		await writeFile(join(auth, 'creds.json'), 'changed')
		await restoreSession(out, auth, { overwrite: true })
		expect(await readFile(join(auth, 'creds.json'), 'utf8')).toBe('{"me":1}')
	})

	it('has nothing to back up without creds.json', async () => {
		const empty = await mkdtemp(join(tmpdir(), 'yui-empty-'))
		await expect(backupSession(empty, join(empty, 'x.yuibackup'))).rejects.toThrow(/nothing to back up/)
		await expect(backupSession(join(empty, 'missing'), join(empty, 'y.yuibackup'))).rejects.toThrow(
			/nothing to back up/
		)
	})

	it('rejects files that are not backups and backups that try to write outside', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'yui-bad-'))
		const junk = join(dir, 'junk')
		await writeFile(junk, 'hello')
		await expect(restoreSession(junk, join(dir, 'a'))).rejects.toThrow(/not a valid/)

		const evil = join(dir, 'evil')
		const files = { 'creds.json': 'e30=', '../escape.json': 'e30=' }
		await writeFile(evil, gzipSync(JSON.stringify({ format: 'yui-bails-session', version: 1, createdAt: 'x', files })))
		await expect(restoreSession(evil, join(dir, 'b'))).rejects.toThrow(/unsafe or missing/)
		await mkdir(join(dir, 'c'), { recursive: true })
		expect(await readdir(join(dir, 'c'))).toEqual([])
	})
})

describe('tagAll', () => {
	it('mentions every member by default, or uses the native @all', async () => {
		const sendMessage = jest.fn<(jid: string, content: unknown, options?: unknown) => Promise<undefined>>(
			async () => undefined
		)
		const extras = makeSendExtras(
			{ sendMessage: sendMessage as never },
			{ groupMetadata: async () => ({ participants: [{ id: A }, { id: B }, { id: A }] }) }
		)

		await extras.tagAll(GROUP, '¡Atención!')
		expect(sendMessage).toHaveBeenLastCalledWith(GROUP, { text: '¡Atención!', mentions: [A, B] }, undefined)

		await extras.tagAll(GROUP, 'Hola', { mode: 'all' })
		expect(sendMessage).toHaveBeenLastCalledWith(GROUP, { text: 'Hola', mentionAll: true }, undefined)
	})

	it('only works in groups and needs member access', async () => {
		const extras = makeSendExtras({ sendMessage: jest.fn() as never })
		await expect(extras.tagAll(A, 'x')).rejects.toThrow(/only works in groups/)
		await expect(extras.tagAll(GROUP, 'x')).rejects.toThrow(/cannot read group members/)
	})
})
