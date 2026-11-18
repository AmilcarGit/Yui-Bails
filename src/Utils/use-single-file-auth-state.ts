import { Boom } from '@hapi/boom'
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

export type SingleFileAuthOptions = {
	/** wait before saving the keys after a change, so many changes become one write. Default 500 ms */
	saveDelayMs?: number
	/** called when a delayed save fails (`flush()` and `saveCreds()` reject instead) */
	onError?: (error: unknown) => void
}

type Stored = { creds: AuthenticationCreds; keys: Record<string, Record<string, unknown>> }

const parseStored = (text: string): Stored | undefined => {
	try {
		const data = JSON.parse(text, BufferJSON.reviver)
		if (data && typeof data === 'object' && data.creds && typeof data.creds === 'object') {
			return { creds: data.creds, keys: data.keys && typeof data.keys === 'object' ? data.keys : {} }
		}
	} catch {
		// handled by the caller
	}

	return undefined
}

/**
 * Keeps the whole login in ONE file (a folder with hundreds of small files is slow, above all on a phone).
 * Changes are kept in memory and written together after a short wait; every write goes to a temporary
 * file that is then renamed, so a crash never leaves a half-written login.
 *
 * Call `await flush()` before you close the bot on purpose so nothing waits to be saved.
 * It is a NEW format: it does not read the folders made by `useMultiFileAuthState`.
 */
export const useSingleFileAuthState = async (
	file: string,
	{ saveDelayMs = 500, onError }: SingleFileAuthOptions = {}
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; flush: () => Promise<void> }> => {
	await mkdir(dirname(file), { recursive: true })

	const read = (path: string) => readFile(path, { encoding: 'utf-8' }).catch(() => undefined)

	const main = await read(file)
	let stored: Stored | undefined
	if (main !== undefined) {
		stored = parseStored(main)
		if (stored) {
			// last readable login, kept in case the file gets damaged later (disk full, SD card…)
			await copyFile(file, `${file}.bak`).catch(() => undefined)
		} else {
			const backup = await read(`${file}.bak`)
			stored = backup === undefined ? undefined : parseStored(backup)
			if (!stored) {
				throw new Boom(
					`The auth file ${file} is damaged and there is no usable backup. Delete it to pair again, or restore a copy.`,
					{ statusCode: 500 }
				)
			}
		}
	}

	const store: Stored = stored ?? { creds: initAuthCreds(), keys: {} }

	let timer: ReturnType<typeof setTimeout> | undefined
	let dirty = false
	let writing: Promise<void> = Promise.resolve()

	const writeNow = async () => {
		const temp = `${file}.tmp`
		try {
			await writeFile(temp, JSON.stringify(store, BufferJSON.replacer), { mode: 0o600 })
			await rename(temp, file)
		} catch (error) {
			await unlink(temp).catch(() => undefined)
			throw error
		}
	}

	const flush = () => {
		if (timer) {
			clearTimeout(timer)
			timer = undefined
		}

		writing = writing
			.catch(() => undefined)
			.then(async () => {
				if (!dirty) return
				dirty = false
				try {
					await writeNow()
				} catch (error) {
					dirty = true
					throw error
				}
			})
		return writing
	}

	const schedule = () => {
		dirty = true
		if (timer) return
		timer = setTimeout(() => {
			timer = undefined
			flush().catch(error => onError?.(error))
		}, saveDelayMs)
	}

	return {
		state: {
			creds: store.creds,
			keys: {
				get: async (type, ids) => {
					const found: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					const bucket = store.keys[type] ?? {}
					for (const id of ids) {
						let value: unknown = bucket[id] ?? null
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value as proto.Message.IAppStateSyncKeyData)
						}

						found[id] = value as SignalDataTypeMap[typeof type]
					}

					return found
				},
				set: async data => {
					for (const category of Object.keys(data)) {
						const items = data[category as keyof SignalDataTypeMap] as Record<string, unknown> | undefined
						if (!items) continue

						const bucket = (store.keys[category] ??= {})
						for (const id of Object.keys(items)) {
							const value = items[id]
							if (value) bucket[id] = value
							else delete bucket[id]
						}
					}

					schedule()
				}
			}
		},
		// the login itself is rare and important: it is written right away
		saveCreds: async () => {
			dirty = true
			await flush()
		},
		flush
	}
}
