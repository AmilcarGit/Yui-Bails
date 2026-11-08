import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'yui-auth-'))

describe('useMultiFileAuthState (safe writes)', () => {
	it('writes through a temporary file and leaves no leftovers', async () => {
		const dir = await tempDir()
		const { state, saveCreds } = await useMultiFileAuthState(dir)
		await saveCreds()

		const files = await fs.readdir(dir)
		expect(files).toContain('creds.json')
		expect(files.some(name => name.endsWith('.tmp'))).toBe(false)
		expect(JSON.parse(await fs.readFile(path.join(dir, 'creds.json'), 'utf-8')).registrationId).toBe(
			state.creds.registrationId
		)
	})

	it('keeps a backup of the last good creds.json', async () => {
		const dir = await tempDir()
		const { saveCreds } = await useMultiFileAuthState(dir)
		await saveCreds()
		expect(await fs.readdir(dir)).not.toContain('creds.json.bak') // nothing to back up yet

		await saveCreds()
		expect(await fs.readdir(dir)).toContain('creds.json.bak')
	})

	it('restores a damaged creds.json from the backup', async () => {
		const dir = await tempDir()
		const first = await useMultiFileAuthState(dir)
		await first.saveCreds()
		await first.saveCreds()

		await fs.writeFile(path.join(dir, 'creds.json'), '{"registrationId": 12') // cut in half

		const second = await useMultiFileAuthState(dir)
		expect(second.state.creds.registrationId).toBe(first.state.creds.registrationId)
		// and the file on disk is healthy again
		expect(() => JSON.parse(await fs.readFile(path.join(dir, 'creds.json'), 'utf-8'))).not.toThrow()
	})

	it('does not keep a damaged file as the backup', async () => {
		const dir = await tempDir()
		const { saveCreds } = await useMultiFileAuthState(dir)
		await saveCreds()
		await saveCreds() // backup = good file
		const good = await fs.readFile(path.join(dir, 'creds.json.bak'), 'utf-8')

		await fs.writeFile(path.join(dir, 'creds.json'), 'garbage')
		await saveCreds()

		expect(await fs.readFile(path.join(dir, 'creds.json.bak'), 'utf-8')).toBe(good)
	})

	it('stores and removes signal keys normally', async () => {
		const dir = await tempDir()
		const { state } = await useMultiFileAuthState(dir)
		await state.keys.set({ session: { 'abc:1': Buffer.from('hola') } })
		expect((await state.keys.get('session', ['abc:1']))['abc:1']?.toString()).toBe('hola')

		await state.keys.set({ session: { 'abc:1': null } })
		expect((await state.keys.get('session', ['abc:1']))['abc:1']).toBeNull()
	})
})
