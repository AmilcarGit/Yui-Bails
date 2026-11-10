import type { ButtonSpec } from '../Types'

const raw = (name: string, params: Record<string, unknown>): ButtonSpec => ({
	name,
	buttonParamsJson: JSON.stringify(params)
})

/**
 * Native flow buttons that exist in WhatsApp's protocol but are not guaranteed to show up for
 * every account or app version: WhatsApp ignores the ones it does not support, and a message can
 * arrive without them. They come from public documentation and other libraries, and have NOT
 * been confirmed by Yui-Bails on real phones. Try one at a time and keep what renders.
 *
 * Use them like any other button: `sock.sendButtons(jid, { text, buttons: [experimentalButtons.requestLocation()] })`.
 */
export const experimentalButtons = {
	/** "Send location" button: opens the share-location screen (`send_location`) */
	requestLocation: (text = '📍 Enviar ubicación'): ButtonSpec => raw('send_location', { display_text: text }),

	/** asks WhatsApp to remind the user later (`cta_reminder`) */
	reminder: (text = '⏰ Recordarme'): ButtonSpec => raw('cta_reminder', { display_text: text }),

	/** cancels a reminder set by `reminder` (`cta_cancel_reminder`) */
	cancelReminder: (text = '🚫 Cancelar recordatorio'): ButtonSpec => raw('cta_cancel_reminder', { display_text: text }),

	/** address form (`address_message`) */
	address: (text = '🏠 Enviar dirección'): ButtonSpec => raw('address_message', { display_text: text }),

	/** opens a page inside WhatsApp without leaving the chat (`open_webview`) */
	webview: (title: string, url: string): ButtonSpec =>
		raw('open_webview', { title, link: { in_app_webview: true, url } }),

	/** any native flow button by name, with its params as an object */
	custom: (name: string, params: Record<string, unknown> = {}): ButtonSpec => raw(name, params)
}
