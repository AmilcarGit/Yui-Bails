import { renderBanner } from '../../Utils/banner'

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

describe('renderBanner', () => {
	const lines = plain(renderBanner('9.9.9'))
		.split('\n')
		.filter(line => line.length > 0)

	it('draws a closed frame where every line has the same width', () => {
		expect(new Set(lines.map(line => [...line].length)).size).toBe(1)
		expect(lines[0]!.startsWith('╭')).toBe(true)
		expect(lines.at(-1)!.startsWith('╰')).toBe(true)
		expect(lines.slice(1, -1).every(line => line.startsWith('│') && line.endsWith('│'))).toBe(true)
	})

	it('fits a phone terminal', () => {
		expect([...lines[0]!].length).toBeLessThanOrEqual(50)
	})

	it('shows the logo, version, creator and repository', () => {
		const text = lines.join('\n')
		expect(text).toContain('██╗   ██╗██╗   ██╗██╗')
		expect(text).toContain('B A I L S')
		expect(text).toContain('v9.9.9')
		expect(text).toContain('AmilcarGit')
		expect(text).toContain('github.com/AmilcarGit/Yui-Bails')
	})
})
