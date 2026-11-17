import { describe, expect, it, jest } from '@jest/globals'
import type { WAMessage } from '../../Types'
import { htmlToWhatsApp } from '../../Utils/html-format'
import { makeSendExtras } from '../../Utils/send-extras'

describe('htmlToWhatsApp', () => {
	it('turns inline tags into WhatsApp formatting', () => {
		expect(htmlToWhatsApp('<b>negrita</b> <i>cursiva</i> <s>tachado</s> <code>x()</code>')).toBe(
			'*negrita* _cursiva_ ~tachado~ `x()`'
		)
		expect(htmlToWhatsApp('<strong>a</strong><em>b</em><del>c</del>')).toBe('*a*_b_~c~')
	})

	it('keeps the markers tight to the text and per line', () => {
		expect(htmlToWhatsApp('<b> hola </b>')).toBe('*hola*')
		expect(htmlToWhatsApp('<b>uno<br>dos</b>')).toBe('*uno*\n*dos*')
		expect(htmlToWhatsApp('<b>  </b>x')).toBe('x')
	})

	it('builds paragraphs, headings, quotes and rules', () => {
		expect(htmlToWhatsApp('<h1>Título</h1><p>uno</p><p>dos</p>')).toBe('*Título*\n\nuno\n\ndos')
		expect(htmlToWhatsApp('<blockquote>cita<br>larga</blockquote>')).toBe('> cita\n> larga')
		expect(htmlToWhatsApp('a<hr>b')).toBe('a\n\n──────────\n\nb')
	})

	it('builds bullet, numbered and nested lists, also with unclosed <li>', () => {
		expect(htmlToWhatsApp('<ul><li>Uno</li><li>Dos<ul><li>Sub</li></ul></li></ul>')).toBe('- Uno\n- Dos\n  - Sub')
		expect(htmlToWhatsApp('<ol><li>Primero<li>Segundo</ol>')).toBe('1. Primero\n2. Segundo')
	})

	it('builds code blocks without formatting inside and without breaking the fence', () => {
		expect(htmlToWhatsApp('<pre><code>if (a) {\n  b()\n}</code></pre>')).toBe('```\nif (a) {\n  b()\n}\n```')
		expect(htmlToWhatsApp('<pre>a ``` b</pre>')).toBe("```\na ''' b\n```")
		expect(htmlToWhatsApp('<pre><b>no</b></pre>')).toBe('```\nno\n```')
	})

	it('shows links with their address and drops unsafe ones', () => {
		expect(htmlToWhatsApp('<a href="https://x.dev/a?b=1&amp;c=2">Mira</a>')).toBe('Mira (https://x.dev/a?b=1&c=2)')
		expect(htmlToWhatsApp('<a href="https://x.dev">https://x.dev</a>')).toBe('https://x.dev')
		expect(htmlToWhatsApp('<a href="https://x.dev"></a>')).toBe('https://x.dev')
		expect(htmlToWhatsApp('<a href="javascript:alert(1)">clic</a>')).toBe('clic')
	})

	it('turns simple tables into rows', () => {
		expect(
			htmlToWhatsApp('<table><tr><th>Cmd</th><th>Uso</th></tr><tr><td>.ping</td><td>Latencia</td></tr></table>')
		).toBe('*Cmd* | *Uso*\n.ping | Latencia')
	})

	it('decodes entities and ignores unknown ones', () => {
		expect(htmlToWhatsApp('&lt;3 &amp; &#x1F600; &#65; &nbsp;fin &bogus; &#0;')).toBe('<3 & 😀 A  fin &bogus; &#0;')
	})

	it('removes scripts, styles, comments and unknown tags but keeps the text', () => {
		expect(
			htmlToWhatsApp(
				'<style>p{color:red}</style><script>if(a<b){x()}</script><!-- nota --><custom onclick="x()">hola</custom><iframe>no</iframe>'
			)
		).toBe('hola')
	})

	it('collapses the whitespace of pretty-printed HTML', () => {
		expect(htmlToWhatsApp('<div>\n   <p>\n      Hola   mundo\n   </p>\n</div>')).toBe('Hola mundo')
		expect(htmlToWhatsApp('a<br>\n   b')).toBe('a\nb')
	})

	it('survives broken, huge and deeply nested HTML', () => {
		expect(htmlToWhatsApp('<b>a</i>b</b></p>c')).toBe('*ab*c')
		expect(htmlToWhatsApp('1 < 2 y <b')).toBe('1 < 2 y <b')
		expect(htmlToWhatsApp('<a title="abierto>x')).toBe('<a title="abierto>x')
		expect(htmlToWhatsApp('x'.repeat(50) + '<b>y</b>', { maxLength: 50 })).toBe('x'.repeat(50))

		const deep = '<b>'.repeat(5000) + 'hola' + '</b>'.repeat(5000)
		expect(htmlToWhatsApp(deep)).toContain('hola')

		const manyOpen = '<a "'.repeat(20000)
		expect(() => htmlToWhatsApp(manyOpen)).not.toThrow()
	})

	it('rejects values that are not text', () => {
		expect(() => htmlToWhatsApp(42 as never)).toThrow(/needs a text/)
	})
})

describe('sendHtml', () => {
	const setup = () => {
		const sendMessage = jest.fn(
			async (jid: string, content: unknown) =>
				({ key: { remoteJid: jid, id: 'M1', fromMe: true }, message: content }) as unknown as WAMessage
		)
		const extras = makeSendExtras({ sendMessage: sendMessage as never }, { sleep: async () => undefined })
		return { extras, sendMessage }
	}

	it('sends the converted text', async () => {
		const { extras, sendMessage } = setup()
		await extras.sendHtml('51900000000@s.whatsapp.net', '<b>Hola</b> <i>mundo</i>', { quoted: undefined })
		expect(sendMessage).toHaveBeenCalledWith(
			'51900000000@s.whatsapp.net',
			{ text: '*Hola* _mundo_' },
			{ quoted: undefined }
		)
	})

	it('refuses HTML without text', async () => {
		const { extras, sendMessage } = setup()
		await expect(extras.sendHtml('51900000000@s.whatsapp.net', '<script>x()</script>')).rejects.toThrow(/no text/)
		expect(sendMessage).not.toHaveBeenCalled()
	})
})
