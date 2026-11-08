import { buildCarouselMessage } from '../../Utils/messages'
import { shouldIncludeBizBinaryNode } from '../../WABinary/generic-utils'

const options = {} as never

describe('buildCarouselMessage', () => {
	it('builds cards with their own texts and native-flow buttons', async () => {
		const message = await buildCarouselMessage(
			{
				text: 'Catálogo',
				footer: 'Yui',
				carousel: [
					{ title: 'Uno', body: 'Primera', buttons: [{ id: 'a', text: 'Comprar' }] },
					{
						title: 'Dos',
						body: 'Segunda',
						footer: 'f',
						buttons: [
							{ text: 'Web', url: 'https://example.com' },
							{ id: 'b', text: 'B' }
						]
					}
				]
			},
			options
		)

		const carousel = message.interactiveMessage!.carouselMessage!
		expect(message.interactiveMessage!.body!.text).toBe('Catálogo')
		expect(carousel.cards).toHaveLength(2)
		expect(carousel.messageVersion).toBe(1)
		expect(carousel.cards![0]!.body!.text).toBe('Primera')
		expect(carousel.cards![0]!.header!.hasMediaAttachment).toBe(false)
		expect(carousel.cards![0]!.nativeFlowMessage!.buttons![0]).toEqual({
			name: 'quick_reply',
			buttonParamsJson: JSON.stringify({ display_text: 'Comprar', id: 'a' })
		})
		expect(carousel.cards![1]!.nativeFlowMessage!.buttons!.map(b => b.name)).toEqual(['cta_url', 'quick_reply'])
	})

	it('validates the number of cards and their buttons', async () => {
		await expect(buildCarouselMessage({ carousel: [] }, options)).rejects.toThrow('at least one card')
		await expect(buildCarouselMessage({ carousel: [{ buttons: [] }] }, options)).rejects.toThrow(
			'card 1 needs at least one button'
		)

		const eleven = Array.from({ length: 11 }, () => ({ buttons: [{ id: 'a', text: 'A' }] }))
		await expect(buildCarouselMessage({ carousel: eleven }, options)).rejects.toThrow('at most 10')
	})

	it('a carousel gets the <biz> node like other interactive messages', async () => {
		const message = await buildCarouselMessage({ carousel: [{ buttons: [{ id: 'a', text: 'A' }] }] }, options)
		expect(shouldIncludeBizBinaryNode(message)).toBe(true)
	})
})
