import { Boom } from '@hapi/boom'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { gunzip, gzip } from 'zlib'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

const FORMAT = 'yui-bails-session'

type BackupFile = {
	format: typeof FORMAT
	version: 1
	createdAt: string
	/** file name -> content in base64 */
	files: Record<string, string>
}

/** auth folders are flat: only plain file names are accepted, so a backup can never write elsewhere */
const isPlainName = (name: string) => /^[\w.@=+-]+$/.test(name) && name !== '.' && name !== '..'

/**
 * Saves the login of a session (its auth folder) in ONE compressed file.
 * The file holds the keys of the account: whoever has it can use the account. Keep it private.
 */
export const backupSession = async (authDir: string, file: string) => {
	const names = (await readdir(authDir).catch(() => [])).filter(isPlainName)
	const files: Record<string, string> = {}

	for (const name of names) {
		const path = join(authDir, name)
		if ((await stat(path)).isFile()) files[name] = (await readFile(path)).toString('base64')
	}

	if (!files['creds.json']) {
		throw new Boom(`There is no login in "${authDir}" (creds.json is missing): nothing to back up`, { statusCode: 404 })
	}

	const data: BackupFile = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), files }
	await mkdir(dirname(file), { recursive: true })
	await writeFile(file, await gzipAsync(Buffer.from(JSON.stringify(data))), { mode: 0o600 })

	return { file, files: Object.keys(files).length, createdAt: data.createdAt }
}

/**
 * Restores a login saved with `backupSession`. It refuses to replace an existing login unless
 * `overwrite` is true.
 */
export const restoreSession = async (file: string, authDir: string, { overwrite = false } = {}) => {
	let data: BackupFile
	try {
		data = JSON.parse((await gunzipAsync(await readFile(file))).toString())
	} catch {
		throw new Boom('That is not a valid Yui-Bails session backup', { statusCode: 400 })
	}

	if (data?.format !== FORMAT || data.version !== 1 || typeof data.files !== 'object' || !data.files) {
		throw new Boom('That is not a valid Yui-Bails session backup', { statusCode: 400 })
	}

	const entries = Object.entries(data.files)
	if (
		entries.some(([name, content]) => !isPlainName(name) || typeof content !== 'string') ||
		!data.files['creds.json']
	) {
		throw new Boom('The backup has unsafe or missing files', { statusCode: 400 })
	}

	const existing = await stat(join(authDir, 'creds.json')).then(
		() => true,
		() => false
	)
	if (existing && !overwrite) {
		throw new Boom(`"${authDir}" already has a login: pass { overwrite: true } to replace it`, { statusCode: 409 })
	}

	await mkdir(authDir, { recursive: true, mode: 0o700 })
	for (const [name, content] of entries) {
		await writeFile(join(authDir, name), Buffer.from(content, 'base64'), { mode: 0o600 })
	}

	return { authDir, files: entries.length, createdAt: data.createdAt }
}
