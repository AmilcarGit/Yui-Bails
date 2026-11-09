import { parseMentions, withAutoMentions } from '../../Utils/mentions'

describe('parseMentions', () => {
	it('finds @number mentions once each', () => {
		expect(parseMentions('hola @51910227479 y @51925679896, otra vez @51910227479')).toEqual([
			'51910227479@s.whatsapp.net',
			'51925679896@s.whatsapp.net'
		])
	})

	it('ignores names, short numbers, e-mails and glued text', () => {
		expect(parseMentions('hola @amilcar @123 correo a@51910227479 x@51910227479.com 51910227479')).toEqual([])
		expect(parseMentions(undefined)).toEqual([])
	})
})

describe('withAutoMentions', () => {
	it('adds mentions from text or caption', () => {
		expect(withAutoMentions({ text: 'hola @51910227479' })).toEqual({
			text: 'hola @51910227479',
			mentions: ['51910227479@s.whatsapp.net']
		})
		const withCaption = withAutoMentions({ caption: '@51910227479', image: Buffer.alloc(1) }) as { mentions?: string[] }
		expect(withCaption.mentions).toEqual(['51910227479@s.whatsapp.net'])
	})

	it('leaves messages with their own mentions, without mentions, or not objects alone', () => {
		const own = { text: '@51910227479', mentions: [] as string[] }
		expect(withAutoMentions(own)).toBe(own)

		const plain = { text: 'sin menciones' }
		expect(withAutoMentions(plain)).toBe(plain)
		expect(withAutoMentions(undefined)).toBeUndefined()
		expect(withAutoMentions('x')).toBe('x')
	})
})
