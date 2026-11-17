import { Boom } from '@hapi/boom'

/**
 * WhatsApp has no HTML. This turns a small, safe part of it into the formatting WhatsApp does have:
 * `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ``` ```` blocks, `- ` / `1. ` lists and `> ` quotes.
 * Everything else (scripts, styles, unknown tags, event attributes) is dropped; only the text is kept.
 */

export type HtmlToWhatsAppOptions = {
	/** most characters of HTML that are read. Default 100000 */
	maxLength?: number
}

type TextNode = { type: 'text'; text: string }
type ElementNode = { type: 'el'; tag: string; attrs: Record<string, string>; children: HtmlNode[] }
type HtmlNode = TextNode | ElementNode

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'area', 'base', 'col'])
/** their content is code or hidden data, never text for the chat */
const RAW_TEXT_TAGS = new Set(['script', 'style'])
/** removed with everything inside */
const DROPPED_TAGS = new Set([
	'script',
	'style',
	'head',
	'title',
	'template',
	'noscript',
	'iframe',
	'object',
	'embed',
	'svg',
	'select',
	'textarea',
	'canvas',
	'audio',
	'video'
])
const MAX_DEPTH = 50

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	copy: '©',
	reg: '®',
	trade: '™',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	laquo: '«',
	raquo: '»',
	euro: '€',
	bull: '•',
	middot: '·',
	times: '×',
	deg: '°'
}

const decodeEntities = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith('#')) {
			const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
			const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
			return valid ? String.fromCodePoint(code) : whole
		}

		return NAMED_ENTITIES[name.toLowerCase()] ?? whole
	})

/** index of the `>` that closes the tag starting at `from`, ignoring `>` inside quotes; -1 when it never closes */
const findTagEnd = (html: string, from: number) => {
	let quote = ''
	for (let index = from; index < html.length; index++) {
		const char = html[index]
		if (quote) {
			if (char === quote) quote = ''
		} else if (char === '"' || char === "'") {
			quote = char
		} else if (char === '>') {
			return index
		}
	}

	return -1
}

const readAttributes = (raw: string) => {
	const attrs: Record<string, string> = {}
	for (const match of raw.matchAll(/\b(href|alt)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
		const name = (match[1] ?? '').toLowerCase()
		attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
	}

	return attrs
}

const parse = (html: string): ElementNode => {
	const root: ElementNode = { type: 'el', tag: '#root', attrs: {}, children: [] }
	const stack: ElementNode[] = [root]
	const current = () => stack[stack.length - 1] ?? root
	const pushText = (text: string) => {
		if (text) current().children.push({ type: 'text', text })
	}

	/** closes the open element `tag` (and what is inside it), looking up to `limit` tags that stop the search */
	const closeOpen = (tag: string, stopAt: string[] = []) => {
		for (let index = stack.length - 1; index > 0; index--) {
			const open = stack[index]?.tag
			if (open === tag) {
				stack.length = index
				return
			}

			if (open && stopAt.includes(open)) return
		}
	}

	let position = 0
	while (position < html.length) {
		const lt = html.indexOf('<', position)
		if (lt === -1) {
			pushText(html.slice(position))
			break
		}

		pushText(html.slice(position, lt))
		const next = html[lt + 1] ?? ''

		if (next === '!') {
			const end = html.startsWith('<!--', lt) ? html.indexOf('-->', lt + 4) : html.indexOf('>', lt)
			const size = html.startsWith('<!--', lt) ? 3 : 1
			position = end === -1 ? html.length : end + size
			continue
		}

		if (!/[a-zA-Z/]/.test(next)) {
			pushText('<')
			position = lt + 1
			continue
		}

		const end = findTagEnd(html, lt + 1)
		if (end === -1) {
			// a tag that never closes: what is left is plain text (also keeps the scan linear)
			pushText(html.slice(lt))
			break
		}

		const raw = html.slice(lt + 1, end)
		position = end + 1

		const named = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw)
		if (!named) continue
		const tag = (named[1] ?? '').toLowerCase()

		if (raw.startsWith('/')) {
			closeOpen(tag)
			continue
		}

		if (RAW_TEXT_TAGS.has(tag)) {
			const closing = new RegExp(`</${tag}\\s*>`, 'gi')
			closing.lastIndex = position
			const found = closing.exec(html)
			position = found ? found.index + found[0].length : html.length
			continue
		}

		// tags that HTML closes by itself when the next one starts
		if (tag === 'li') closeOpen('li', ['ul', 'ol'])
		else if (tag === 'p') closeOpen('p', ['div', 'li', 'td', 'th', 'blockquote'])
		else if (tag === 'td' || tag === 'th') {
			closeOpen('td', ['tr'])
			closeOpen('th', ['tr'])
		} else if (tag === 'tr') {
			closeOpen('tr', ['table'])
		}

		const element: ElementNode = {
			type: 'el',
			tag,
			attrs: tag === 'a' || tag === 'img' ? readAttributes(raw) : {},
			children: []
		}
		current().children.push(element)

		const selfClosed = VOID_TAGS.has(tag) || raw.trimEnd().endsWith('/')
		if (!selfClosed && stack.length < MAX_DEPTH) stack.push(element)
	}

	return root
}

type Context = { pre: boolean }

/** marks every non-empty line separately: WhatsApp formatting does not cross line breaks */
const wrapInline = (inner: string, mark: string) =>
	inner
		.split('\n')
		.map(line => {
			const text = line.trim()
			if (!text) return line
			const lead = line.slice(0, line.length - line.trimStart().length)
			const trail = line.slice(line.trimEnd().length)
			return `${lead}${mark}${text}${mark}${trail}`
		})
		.join('\n')

const block = (content: string) => (content.trim() ? `\n\n${content.trim()}\n\n` : '')
const oneLine = (content: string) => (content.trim() ? `\n${content.trim()}\n` : '')

const SAFE_LINK = /^(https?:|mailto:|tel:)/i
const BLOCK_TAGS = new Set([
	'div',
	'section',
	'article',
	'header',
	'footer',
	'main',
	'nav',
	'aside',
	'figure',
	'figcaption'
])
const PARAGRAPH_TAGS = new Set(['p', 'dl', 'dt', 'dd', 'address', 'details', 'summary', 'fieldset'])

const renderChildren = (element: ElementNode, context: Context): string => {
	let out = ''
	for (const child of element.children) {
		let piece = render(child, context)
		// pretty-printed HTML puts spaces after a line break; they are not content
		if (!context.pre && (out === '' || out.endsWith('\n'))) piece = piece.replace(/^ +/, '')
		out += piece
	}

	return out
}

const collectRows = (element: ElementNode): ElementNode[] => {
	const rows: ElementNode[] = []
	for (const child of element.children) {
		if (child.type !== 'el') continue
		if (child.tag === 'tr') rows.push(child)
		else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') rows.push(...collectRows(child))
	}

	return rows
}

const renderList = (element: ElementNode, context: Context) => {
	const ordered = element.tag === 'ol'
	const items: string[] = []
	let number = 0
	for (const child of element.children) {
		if (child.type === 'el' && child.tag === 'li') {
			const body = renderChildren(child, context).trim()
			if (!body) continue
			number++
			const [first = '', ...rest] = body.split('\n')
			const marker = ordered ? `${number}.` : '-'
			items.push([`${marker} ${first}`, ...rest.map(text => (text ? `  ${text}` : text))].join('\n'))
		} else {
			const other = render(child, context).trim()
			if (other) items.push(other)
		}
	}

	return oneLine(items.join('\n'))
}

const renderTable = (element: ElementNode, context: Context) => {
	const rows = collectRows(element).map(row => {
		const cells: string[] = []
		for (const cell of row.children) {
			if (cell.type !== 'el' || (cell.tag !== 'td' && cell.tag !== 'th')) continue
			const text = renderChildren(cell, context).replace(/\s+/g, ' ').trim()
			cells.push(cell.tag === 'th' && text ? wrapInline(text, '*') : text)
		}

		return cells.join(' | ')
	})

	return block(rows.filter(Boolean).join('\n'))
}

const render = (node: HtmlNode, context: Context): string => {
	if (node.type === 'text') {
		return decodeEntities(context.pre ? node.text : node.text.replace(/\s+/g, ' '))
	}

	const { tag } = node
	if (DROPPED_TAGS.has(tag)) return ''

	if (tag === 'ul' || tag === 'ol') return renderList(node, context)
	if (tag === 'table') return renderTable(node, context)

	if (tag === 'pre') {
		const code = renderChildren(node, { pre: true }).replace(/^\n+/, '').replace(/\s+$/, '').replace(/```/g, "'''")
		return code ? block(`\`\`\`\n${code}\n\`\`\``) : ''
	}

	const inner = renderChildren(node, context)
	// inside a code block nothing is formatted, only line breaks are kept
	if (context.pre && tag !== 'br') return inner

	switch (tag) {
		case 'b':
		case 'strong':
			return wrapInline(inner, '*')
		case 'i':
		case 'em':
		case 'cite':
		case 'dfn':
			return wrapInline(inner, '_')
		case 's':
		case 'strike':
		case 'del':
			return wrapInline(inner, '~')
		case 'code':
		case 'kbd':
		case 'samp':
		case 'tt':
			return context.pre ? inner : wrapInline(inner, '`')
		case 'br':
			return '\n'
		case 'hr':
			return block('──────────')
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			return block(wrapInline(inner.replace(/\s+/g, ' ').trim(), '*'))
		case 'blockquote': {
			const quoted = inner
				.replace(/[ \t]+$/gm, '')
				.replace(/\n{3,}/g, '\n\n')
				.trim()
			return quoted
				? block(
						quoted
							.split('\n')
							.map(text => (text ? `> ${text}` : '>'))
							.join('\n')
					)
				: ''
		}

		case 'li':
			return oneLine(`- ${inner.trim()}`)
		case 'a': {
			const text = inner.trim()
			const href = (node.attrs.href ?? '').trim()
			if (!SAFE_LINK.test(href)) return inner
			if (!text) return href
			return text.includes(href) ? text : `${text} (${href})`
		}

		case 'img':
			return node.attrs.alt ?? ''
		default:
			if (PARAGRAPH_TAGS.has(tag)) return block(inner)
			if (BLOCK_TAGS.has(tag)) return oneLine(inner)
			return inner
	}
}

/** Converts HTML to a text with WhatsApp formatting. Returns an empty text when there is nothing to show. */
export const htmlToWhatsApp = (html: string, { maxLength = 100_000 }: HtmlToWhatsAppOptions = {}): string => {
	if (typeof html !== 'string') throw new Boom('htmlToWhatsApp needs a text', { statusCode: 400 })

	const source = html.length > maxLength ? html.slice(0, maxLength) : html
	return renderChildren(parse(source), { pre: false })
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}
