/**
 * Prints the Yui-Bails banner once per process.
 * Set YUI_BAILS_NO_BANNER=1 to disable it.
 */

const ESC = '\x1b['
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`

// cyan -> blue -> violet -> magenta gradient (256-color)
const GRADIENT = [51, 45, 39, 69, 105, 141, 177, 213, 207, 201]

const paint = (text: string, color: number, bold = false) => `${bold ? BOLD : ''}${ESC}38;5;${color}m${text}${RESET}`

const gradientLine = (text: string, offset = 0) => {
	const chars = [...text]
	const step = Math.max(1, Math.floor(chars.length / GRADIENT.length))
	return (
		chars
			.map((ch, i) => {
				const color = GRADIENT[Math.min(GRADIENT.length - 1, Math.floor(i / step) + offset)] ?? 201
				return `${ESC}38;5;${color}m${ch}`
			})
			.join('') + RESET
	)
}

/** version of Yui-Bails, shown in the banner */
export const YUI_BAILS_VERSION = '1.3.0'

let printed = false

// "YUI" in block letters, 21 columns wide
const LOGO = [
	'██╗   ██╗██╗   ██╗██╗',
	'╚██╗ ██╔╝██║   ██║██║',
	' ╚████╔╝ ██║   ██║██║',
	'  ╚██╔╝  ██║   ██║██║',
	'   ██║   ╚██████╔╝██║',
	'   ╚═╝    ╚═════╝ ╚═╝'
]

const LOGO_WIDTH = Math.max(...LOGO.map(l => l.length))
const WIDTH = 46

/** the banner as text (colors included). Separate from `printBanner` so it can be tested. */
export const renderBanner = (version: string = YUI_BAILS_VERSION) => {
	const line = '─'.repeat(WIDTH)
	const edge = (ch: string) => paint(ch, 105)

	// `visible` is the length without colors: it is what decides the centering
	const center = (text: string, visible: number) => {
		const left = Math.max(0, Math.floor((WIDTH - visible) / 2))
		return ' '.repeat(left) + text + ' '.repeat(Math.max(0, WIDTH - visible - left))
	}

	const row = (text = '', visible = 0) => `${edge('│')}${center(text, visible)}${edge('│')}`

	const sparkle = (n: number) => paint('✦', GRADIENT[n % GRADIENT.length] ?? 201)
	const features = ['botones, carruseles y listas nativas', 'cola anti-ban · multi-sesión', 'sesión a prueba de cortes']
	const widest = Math.max(...features.map(f => f.length))
	const credit = 'creado por AmilcarGit'
	const repo = 'github.com/AmilcarGit/Yui-Bails'

	return [
		'',
		`${edge('╭')}${gradientLine(line)}${edge('╮')}`,
		row(),
		...LOGO.map((l, n) => row(BOLD + gradientLine(l.padEnd(LOGO_WIDTH), Math.min(n, 3)), LOGO_WIDTH)),
		row(),
		row(`${sparkle(1)} ${gradientLine('B A I L S', 2)} ${sparkle(8)}`, 13),
		row(paint(`v${version}`, 250, true), version.length + 1),
		row(),
		// the list is centered as a block so the bullets line up
		...features.map(f => {
			const margin = Math.floor((WIDTH - (widest + 2)) / 2)
			return `${edge('│')}${' '.repeat(margin)}${paint('◆', 105)} ${paint(f, 250)}${' '.repeat(WIDTH - margin - f.length - 2)}${edge('│')}`
		}),
		row(),
		row(`${DIM}${credit}${RESET}`, credit.length),
		row(paint(repo, 69), repo.length),
		`${edge('╰')}${gradientLine(line, 3)}${edge('╯')}`,
		''
	].join('\n')
}

export const printBanner = (version: string = YUI_BAILS_VERSION) => {
	if (printed || process.env.YUI_BAILS_NO_BANNER) {
		return
	}

	printed = true
	console.log(renderBanner(version))
}

let versionNoticePrinted = false

/** where the WA Web version a connection announces came from */
export type WaVersionSource =
	/** read from WA's servers just now */
	| 'live'
	/** pinned by the bot through `version` */
	| 'pinned'
	/** WA could not be reached, so the version shipped with the library is used */
	| 'bundled'

/**
 * Prints, once per process, which WA Web version the connection is using & where
 * it came from. Most bots run with a silent logger, so this is the only way they
 * get to see that an old version is in play -- which is exactly what makes
 * WhatsApp refuse to link a device.
 */
export const printWaVersionNotice = ({ version, source }: { version: number[]; source: WaVersionSource }) => {
	if (versionNoticePrinted || process.env.YUI_BAILS_NO_BANNER) {
		return
	}

	versionNoticePrinted = true

	const v = `v${version.join('.')}`

	if (source === 'bundled') {
		console.log(
			`${paint('⚠', 214)} ${paint(
				`No se pudo consultar la versión de WA Web: se usa la incluida (${v}).`,
				214
			)}\n  ${paint('Si WhatsApp ya publicó una más nueva, la vinculación fallará ("código incorrecto").', 250)}\n`
		)
		return
	}

	const label = source === 'live' ? 'en vivo' : 'fijada'
	console.log(`${paint('◆', 105)} ${paint(`WA Web ${v} (${label})`, 250)}\n`)
}
