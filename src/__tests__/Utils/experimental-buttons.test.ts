import { describe, expect, it } from '@jest/globals'
import { experimentalButtons } from '../../Utils/experimental-buttons'

describe('experimentalButtons', () => {
	it('builds raw native flow buttons with the right name and params', () => {
		const location = experimentalButtons.requestLocation('Mi ubicación')
		expect(location.name).toBe('send_location')
		expect(JSON.parse(location.buttonParamsJson!)).toEqual({ display_text: 'Mi ubicación' })

		expect(experimentalButtons.reminder().name).toBe('cta_reminder')
		expect(experimentalButtons.cancelReminder().name).toBe('cta_cancel_reminder')
		expect(experimentalButtons.address().name).toBe('address_message')

		const web = experimentalButtons.webview('Mi web', 'https://example.com')
		expect(web.name).toBe('open_webview')
		expect(JSON.parse(web.buttonParamsJson!)).toEqual({
			title: 'Mi web',
			link: { in_app_webview: true, url: 'https://example.com' }
		})
	})

	it('custom takes any name', () => {
		const button = experimentalButtons.custom('algo_nuevo', { a: 1 })
		expect(button).toEqual({ name: 'algo_nuevo', buttonParamsJson: '{"a":1}' })
	})
})
