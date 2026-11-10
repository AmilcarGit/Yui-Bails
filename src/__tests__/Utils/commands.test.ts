import { describe, expect, it, jest } from '@jest/globals'
import { EventEmitter } from 'events'
import type { WAMessage } from '../../Types'
import { type CommandsOptions, makeCommands } from '../../Utils/commands'
import { getSenderIds } from '../../Utils/helpers'

const CHAT = '1203@g.us'

const msg = (text: string, user = '111', extra: object = {}) =>
	({
		key: { remoteJid: CHAT, participant: `${user}@s.whatsapp.net`, id: `ID${Math.random()}`, ...extra },
		message: { conversation: text }
	}) as unknown as WAMessage

const setup = (options: CommandsOptions = {}, admins: string[] = []) => {
	const ev = new EventEmitter()
	const sent: Array<{ jid: string; content: any }> = []
	let time = 0

	const commands = makeCommands(
		{
			ev: ev as any,
			getSender: async m => getSenderIds(m),
			sendMessage: async (jid, content) => void sent.push({ jid, content }),
			isAdmin: async (_jid, who) => admins.includes(who.number || '')
		},
		{ now: () => time, ...options }
	)

	return { commands, sent, ev, advance: (ms: number) => void (time += ms) }
}

describe('makeCommands', () => {
	it('runs a command with its arguments and ignores the rest', async () => {
		const { commands } = setup()
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'eco', run })

		await expect(commands.handle(msg('hola'))).resolves.toBe(false)
		await expect(commands.handle(msg('.noexiste'))).resolves.toBe(false)
		await expect(commands.handle(msg('.eco uno  dos tres'))).resolves.toBe(true)

		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'eco',
				prefix: '.',
				text: 'uno  dos tres',
				args: ['uno', 'dos', 'tres'],
				isGroup: true
			})
		)
	})

	it('accepts aliases, several prefixes and is case-insensitive', async () => {
		const { commands } = setup()
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'menu', aliases: ['ayuda'], run })

		await commands.handle(msg('!AYUDA'))
		await commands.handle(msg('/Menu'))
		expect(run).toHaveBeenCalledTimes(2)
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'menu', prefix: '!' }))
	})

	it('works without prefix when asked', async () => {
		const { commands } = setup({ prefix: false })
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'ping', run })

		await commands.handle(msg('ping'))
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('refuses repeated names and aliases, and can remove commands', () => {
		const { commands } = setup()
		commands.add({ name: 'a', aliases: ['b'], run: async () => undefined })

		expect(() => commands.add({ name: 'b', run: async () => undefined })).toThrow(/already exists/)
		expect(() => commands.add({ name: 'x y', run: async () => undefined })).toThrow(/Invalid command name/)
		expect(commands.remove('b')).toBe(true)
		expect(commands.get('a')).toBeUndefined()
		expect(commands.list()).toHaveLength(0)
	})

	it('owner commands: only owners, or the linked number', async () => {
		const { commands, sent } = setup({ owners: ['999'] })
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'apagar', role: 'owner', run })

		await commands.handle(msg('.apagar', '111'))
		expect(run).not.toHaveBeenCalled()
		expect(sent[0]!.content.text).toContain('dueño')

		await commands.handle(msg('.apagar', '999'))
		await commands.handle(msg('.apagar', '555', { fromMe: true }))
		expect(run).toHaveBeenCalledTimes(2)
	})

	it('admin commands: group admins and owners', async () => {
		const { commands, sent } = setup({ owners: ['999'] }, ['222'])
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'kick', role: 'admin', run })

		await commands.handle(msg('.kick', '111'))
		expect(sent[0]!.content.text).toContain('admins')

		await commands.handle(msg('.kick', '222'))
		await commands.handle(msg('.kick', '999'))
		expect(run).toHaveBeenCalledTimes(2)
	})

	it('group only and private only', async () => {
		const { commands, sent } = setup()
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'privado', privateOnly: true, run })

		await commands.handle(msg('.privado'))
		expect(run).not.toHaveBeenCalled()
		expect(sent[0]!.content.text).toContain('chats privados')
	})

	it('cooldown per user, but not for owners', async () => {
		const { commands, sent, advance } = setup({ owners: ['999'], spam: false })
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'ping', cooldownMs: 5000, run })

		await commands.handle(msg('.ping', '111'))
		await commands.handle(msg('.ping', '111'))
		expect(run).toHaveBeenCalledTimes(1)
		expect(sent.at(-1)?.content.text).toContain('Espera 5 s')

		await commands.handle(msg('.ping', '222'))
		await commands.handle(msg('.ping', '999'))
		await commands.handle(msg('.ping', '999'))
		expect(run).toHaveBeenCalledTimes(4)

		advance(5000)
		await commands.handle(msg('.ping', '111'))
		expect(run).toHaveBeenCalledTimes(5)
	})

	it('ignores a user who sends too many commands, warning once', async () => {
		const { commands, sent } = setup({ spam: { max: 2, windowMs: 10_000 } })
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'ping', run })

		for (let i = 0; i < 6; i++) await commands.handle(msg('.ping'))
		expect(run).toHaveBeenCalledTimes(2)
		expect(sent.filter(s => s.content.text.includes('muy rápido'))).toHaveLength(1)
	})

	it('a failing command does not break the bot', async () => {
		const { commands, sent } = setup()
		commands.add({
			name: 'roto',
			run: async () => {
				throw new Error('boom')
			}
		})

		await expect(commands.handle(msg('.roto'))).resolves.toBe(true)
		expect(sent[0]!.content.text).toContain('salió mal')

		const onError = jest.fn()
		const custom = setup({ onError })
		custom.commands.add({
			name: 'roto',
			run: async () => {
				throw new Error('boom')
			}
		})
		await custom.commands.handle(msg('.roto'))
		expect(onError).toHaveBeenCalledTimes(1)
	})

	it('reply quotes the command', async () => {
		const { commands, sent } = setup()
		commands.add({ name: 'hola', run: ctx => void ctx.reply('¡hola!') })

		await commands.handle(msg('.hola'))
		expect(sent[0]).toMatchObject({ jid: CHAT, content: { text: '¡hola!' } })
	})

	it('listen handles live messages only', async () => {
		const { commands, ev } = setup()
		const run = jest.fn(async (_ctx: unknown) => undefined)
		commands.add({ name: 'ping', run })
		const stop = commands.listen()

		ev.emit('messages.upsert', { type: 'append', messages: [msg('.ping')] })
		ev.emit('messages.upsert', { type: 'notify', messages: [msg('.ping')] })
		await new Promise(resolve => setImmediate(resolve))
		expect(run).toHaveBeenCalledTimes(1)
		expect(typeof stop).toBe('function')
	})
})
