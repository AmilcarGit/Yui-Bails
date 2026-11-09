/** the number must not be glued to a word or another @ (so e-mails are not mentions) */
const MENTION = /(?<![\w@])@(\d{7,15})(?!\d)/g

/**
 * Finds `@5191…` style mentions in a text and returns their jids.
 * Only digits count; `@name` is left alone.
 */
export const parseMentions = (text: string | null | undefined): string[] => {
	if (!text) return []

	const jids = new Set<string>()
	for (const match of text.matchAll(MENTION)) jids.add(`${match[1]}@s.whatsapp.net`)

	return [...jids]
}

/**
 * Adds `mentions` to a message that writes `@number` in its text or caption, unless the
 * message already sets `mentions` itself. Anything else is returned untouched.
 */
export const withAutoMentions = <T>(content: T): T => {
	if (!content || typeof content !== 'object') return content

	const message = content as Record<string, unknown>
	if (message.mentions !== undefined) return content

	const text = typeof message.text === 'string' ? message.text : message.caption
	const jids = typeof text === 'string' ? parseMentions(text) : []

	return jids.length ? ({ ...message, mentions: jids } as T) : content
}
