import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import type { WAMessage } from '../../Types'
import { getSenderIds } from '../../Utils/helpers'
import { makeInteractive } from '../../Utils/interactive'
import { makeReplyTools } from '../../Utils/replies'

const CHAT = '1203@g.us'

const from = (user: string, message: WAMessage['message'] = { conversation: 'x' }, id = `M-${Math.random()}`) =>
	({ key: { remoteJid: CHAT, participant: `${user}@s.whatsapp.net`, id }, message }) as WAMessage

type Sent = { jid: string; content: any }

const setup = (admins: string[] = []) => {
	const ev = new EventEmitter()
	const replies = makeReplyTools({ ev, getSender: async msg => getSenderIds(msg) })
	const sent: Sent[] = []
	const disabled: WAMessage[] = []
	let n = 0

	const send = async (jid: string, content: any) => {
		sent.push({ jid, content })
		n += 1
		return { key: { remoteJid: jid, id: `SENT${n}`, fromMe: true } } as WAMessage
	}

	const interactive = makeInteractive({
		sendMessage: send,
		sendButtons: (jid, options) => send(jid, options),
		disableButtons: async msg => void disabled.push(msg) || true,
		getSender: async msg => getSenderIds(msg),
		onReply: (matcher, run) => replies.onReply(matcher, run),
		isAdmin: async (_jid, who) => admins.includes(who.number || '')
	})

	/** a user taps the button with this id */
	const tap = async (user: string, id: string) => {
		const msg = from(user, { buttonsResponseMessage: { selectedButtonId: id, selectedDisplayText: 'btn' } })
		ev.emit('messages.upsert', { messages: [msg], type: 'notify' })
		await new Promise(resolve => setImmediate(resolve))
		return msg
	}

	const buttonsOf = (index: number): any[] => sent[index]?.content.buttons || []
	return { interactive, sent, disabled, tap, buttonsOf }
}

describe('confirm', () => {
	it('resolves true when the asker taps yes, and removes the buttons', async () => {
		const { interactive, buttonsOf, tap, disabled } = setup()
		const answer = interactive.confirm(from('111'), '¿Seguro?')
		await new Promise(resolve => setImmediate(resolve))

		await tap('111', buttonsOf(0)[0].id)
		await expect(answer).resolves.toBe(true)
		expect(disabled).toHaveLength(1)
	})

	it('resolves false on no', async () => {
		const { interactive, buttonsOf, tap } = setup()
		const answer = interactive.confirm(from('111'), '¿Seguro?')
		await new Promise(resolve => setImmediate(resolve))

		await tap('111', buttonsOf(0)[1].id)
		await expect(answer).resolves.toBe(false)
	})

	it('ignores other people and tells them it is not theirs', async () => {
		const { interactive, buttonsOf, tap, sent } = setup()
		const answer = interactive.confirm(from('111'), '¿Seguro?', { timeoutMs: 40 })
		await new Promise(resolve => setImmediate(resolve))

		await tap('222', buttonsOf(0)[0].id)
		expect(sent.at(-1)?.content.text).toContain('no es para ti')
		await expect(answer).resolves.toBe(false) // nobody allowed answered: timed out
	})

	it('resolves false when time runs out', async () => {
		const { interactive } = setup()
		await expect(interactive.confirm(from('111'), '¿Seguro?', { timeoutMs: 20 })).resolves.toBe(false)
	})
})

describe('paginate', () => {
	const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

	it('shows the first page with only a "next" button', async () => {
		const { interactive, sent, buttonsOf } = setup()
		await interactive.paginate(from('111'), items, { perPage: 3, title: 'Letras' })

		expect(sent[0]!.content.text).toBe('Letras\n\n1. a\n2. b\n3. c')
		expect(sent[0]!.content.footer).toContain('Página 1 de 3')
		expect(buttonsOf(0).map(b => b.text)).toEqual(['Siguiente ▶'])
	})

	it('goes forward and back, removing the old buttons', async () => {
		const { interactive, sent, buttonsOf, tap, disabled } = setup()
		await interactive.paginate(from('111'), items, { perPage: 3 })

		await tap('111', buttonsOf(0)[0].id)
		expect(sent[1]!.content.text).toBe('4. d\n5. e\n6. f')
		expect(buttonsOf(1).map(b => b.text)).toEqual(['◀ Anterior', 'Siguiente ▶'])
		expect(disabled).toHaveLength(1)

		await tap('111', buttonsOf(1)[1].id)
		expect(sent[2]!.content.text).toBe('7. g')
		expect(buttonsOf(2).map(b => b.text)).toEqual(['◀ Anterior'])
	})

	it('sends plain text for a single page and a notice for no items', async () => {
		const { interactive, sent } = setup()
		await interactive.paginate(from('111'), ['a', 'b'], { perPage: 5 })
		expect(sent[0]!.content.buttons).toBeUndefined()

		await interactive.paginate(from('111'), [], { empty: 'Vacío' })
		expect(sent[1]!.content.text).toBe('Vacío')
	})

	it('only the asker can turn pages', async () => {
		const { interactive, sent, buttonsOf, tap } = setup()
		await interactive.paginate(from('111'), items, { perPage: 3 })
		await tap('222', buttonsOf(0)[0].id)

		expect(sent).toHaveLength(2)
		expect(sent[1]!.content.text).toContain('no es para ti')
	})
})

describe('menu', () => {
	const run = jest.fn<(tap: unknown) => Promise<undefined>>(async () => undefined)
	const definition = {
		title: 'Menú',
		text: 'Elige',
		items: [
			{
				title: 'Juegos',
				items: [
					{ title: 'Dado', run },
					{ title: 'Moneda', text: 'Cara o cruz' }
				]
			},
			{ title: 'Info', text: 'Soy un bot' }
		]
	}

	const rowsOf = (sent: Sent[], index: number): any[] => sent[index]!.content.buttons[0].sections[0].rows

	it('opens sub-menus with a back row and runs leaves', async () => {
		const { interactive, sent, tap } = setup()
		await interactive.menu(from('111'), definition)

		expect(rowsOf(sent, 0).map(r => r.title)).toEqual(['Juegos', 'Info'])

		await tap('111', rowsOf(sent, 0)[0].id)
		expect(rowsOf(sent, 1).map(r => r.title)).toEqual(['Dado', 'Moneda', '⬅ Volver'])

		await tap('111', rowsOf(sent, 1)[0].id)
		expect(run).toHaveBeenCalledTimes(1)
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ path: ['Juegos', 'Dado'] }))

		await tap('111', rowsOf(sent, 1)[1].id)
		expect(sent.at(-1)?.content.text).toBe('Cara o cruz')
	})

	it('goes back to the parent menu', async () => {
		const { interactive, sent, tap } = setup()
		await interactive.menu(from('111'), definition)
		await tap('111', rowsOf(sent, 0)[0].id)
		await tap('111', rowsOf(sent, 1)[2].id)

		expect(rowsOf(sent, 2).map(r => r.title)).toEqual(['Juegos', 'Info'])
	})

	it('sends the text of a leaf row', async () => {
		const { interactive, sent, tap } = setup()
		await interactive.menu(from('111'), definition)
		await tap('111', rowsOf(sent, 0)[1].id)
		expect(sent.at(-1)?.content.text).toBe('Soy un bot')
	})

	it('needs items', async () => {
		const { interactive } = setup()
		await expect(interactive.menu(from('111'), { items: [] })).rejects.toThrow('at least one item')
	})
})

describe('sendGuardedButtons', () => {
	const options = {
		text: 'Panel',
		buttons: [
			{ text: 'Borrar', id: 'borrar' },
			{ text: 'Web', url: 'https://x.com' }
		]
	}

	it('lets only the allowed person tap and gives back your own id', async () => {
		const { interactive, buttonsOf, tap, sent } = setup()
		const onTap = jest.fn<(tap: unknown) => Promise<undefined>>(async () => undefined)
		await interactive.sendGuardedButtons(from('111'), options, onTap)

		expect(buttonsOf(0)[0].id).not.toBe('borrar')
		expect(buttonsOf(0)[1]).toEqual({ text: 'Web', url: 'https://x.com' })

		await tap('222', buttonsOf(0)[0].id)
		expect(onTap).not.toHaveBeenCalled()
		expect(sent.at(-1)?.content.text).toContain('no es para ti')

		await tap('111', buttonsOf(0)[0].id)
		expect(onTap).toHaveBeenCalledWith(expect.objectContaining({ id: 'borrar' }))
	})

	it('who: "admins" accepts group admins only', async () => {
		const { interactive, buttonsOf, tap } = setup(['333'])
		const onTap = jest.fn<(tap: unknown) => Promise<undefined>>(async () => undefined)
		await interactive.sendGuardedButtons(from('111'), { ...options, who: 'admins' }, onTap)

		await tap('111', buttonsOf(0)[0].id)
		expect(onTap).not.toHaveBeenCalled()

		await tap('333', buttonsOf(0)[0].id)
		expect(onTap).toHaveBeenCalledTimes(1)
	})

	it('accepts a custom check and "anyone"', async () => {
		const { interactive, buttonsOf, tap } = setup()
		const onTap = jest.fn<(tap: unknown) => Promise<undefined>>(async () => undefined)
		await interactive.sendGuardedButtons(from('111'), { ...options, who: 'anyone' }, onTap)
		await tap('999', buttonsOf(0)[0].id)
		expect(onTap).toHaveBeenCalledTimes(1)

		await interactive.sendGuardedButtons(from('111'), { ...options, who: tapper => tapper.number === '555' }, onTap)
		await tap('444', buttonsOf(1)[0].id)
		await tap('555', buttonsOf(1)[0].id)
		expect(onTap).toHaveBeenCalledTimes(2)
	})

	it('once: only the first tap counts', async () => {
		const { interactive, buttonsOf, tap, disabled } = setup()
		const onTap = jest.fn<(tap: unknown) => Promise<undefined>>(async () => undefined)
		await interactive.sendGuardedButtons(from('111'), { ...options, once: true }, onTap)

		await tap('111', buttonsOf(0)[0].id)
		await tap('111', buttonsOf(0)[0].id)
		expect(onTap).toHaveBeenCalledTimes(1)
		expect(disabled).toHaveLength(1)
	})

	it('guards the rows of a dropdown too', async () => {
		const { interactive, sent, tap } = setup()
		const onTap = jest.fn<(tap: unknown) => Promise<undefined>>(async () => undefined)
		await interactive.sendGuardedButtons(
			from('111'),
			{ text: 'x', buttons: [{ text: 'Abrir', sections: [{ title: 'S', rows: [{ title: 'Uno', id: 'uno' }] }] }] },
			onTap
		)

		const row = sent[0]!.content.buttons[0].sections[0].rows[0]
		expect(row.id).not.toBe('uno')
		await tap('111', row.id)
		expect(onTap).toHaveBeenCalledWith(expect.objectContaining({ id: 'uno' }))
	})
})

describe('sendRepeatable', () => {
	it('sends again on every tap, with a fresh result and without the old button', async () => {
		const { interactive, sent, buttonsOf, tap, disabled } = setup()
		let count = 0
		await interactive.sendRepeatable(from('111'), () => `frase ${++count}`)

		expect(sent[0]!.content.text).toBe('frase 1')
		await tap('222', buttonsOf(0)[0].id) // anyone may tap by default
		expect(sent[1]!.content.text).toBe('frase 2')
		expect(disabled).toHaveLength(1)
	})

	it('stops offering the button after maxRepeats', async () => {
		const { interactive, sent, buttonsOf, tap } = setup()
		await interactive.sendRepeatable(from('111'), 'hola', { maxRepeats: 1 })

		await tap('111', buttonsOf(0)[0].id)
		expect(sent[1]!.content.buttons).toBeUndefined()
	})

	it('can repeat media with a caption', async () => {
		const { interactive, sent } = setup()
		await interactive.sendRepeatable(from('111'), { image: { url: 'x.jpg' }, caption: 'foto' })
		expect(sent[0]!.content).toMatchObject({ image: { url: 'x.jpg' }, caption: 'foto' })
		expect(sent[0]!.content.buttons).toHaveLength(1)
	})
})

describe('old or unknown buttons', () => {
	it('says the button expired', async () => {
		const { tap, sent } = setup()
		await tap('111', 'yui:desconocido:y')
		expect(sent.at(-1)?.content.text).toContain('venció')
	})
})
