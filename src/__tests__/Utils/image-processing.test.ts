import { describe, expect, it, jest } from '@jest/globals'
import { buildVideoThumbArgs, getImageProcessingLibrary, napiSquare, napiThumb } from '../../Utils/messages-media'

const none = async () => undefined

describe('getImageProcessingLibrary', () => {
	it('prefers sharp, then @napi-rs/image, then jimp', async () => {
		const sharp = { name: 'sharp' }
		const napi = { Transformer: class {} }
		const jimp = { name: 'jimp' }

		await expect(
			getImageProcessingLibrary({ sharp: async () => sharp, napi: async () => napi, jimp: async () => jimp })
		).resolves.toEqual({ sharp })
		await expect(
			getImageProcessingLibrary({ sharp: none, napi: async () => napi, jimp: async () => jimp })
		).resolves.toEqual({ napi })
		await expect(getImageProcessingLibrary({ sharp: none, napi: none, jimp: async () => jimp })).resolves.toEqual({
			jimp
		})
	})

	it('ignores a module without Transformer and does not load later libraries when one works', async () => {
		const jimpLoader = jest.fn(async () => ({ name: 'jimp' }))
		const napiLoader = jest.fn(async () => ({ Transformer: class {} }))

		await getImageProcessingLibrary({ sharp: async () => ({}), napi: napiLoader, jimp: jimpLoader })
		expect(napiLoader).not.toHaveBeenCalled()

		await expect(getImageProcessingLibrary({ sharp: none, napi: async () => ({}), jimp: jimpLoader })).resolves.toEqual(
			{ jimp: { name: 'jimp' } }
		)
	})

	it('explains what to install when there is none', async () => {
		await expect(getImageProcessingLibrary({ sharp: none, napi: none, jimp: none })).rejects.toThrow(
			/sharp, @napi-rs\/image or jimp/
		)
	})
})

describe('@napi-rs/image helpers', () => {
	const fakeNapi = () => {
		const calls: string[] = []
		class Transformer {
			constructor(public input: Buffer) {
				calls.push('new')
			}

			async metadata() {
				return { width: 400, height: 200 }
			}

			resize(...args: number[]) {
				calls.push(`resize:${args.join('x')}`)
				return this
			}

			crop(...args: number[]) {
				calls.push(`crop:${args.join(',')}`)
				return this
			}

			async jpeg(quality: number) {
				calls.push(`jpeg:${quality}`)
				return Buffer.from('jpeg')
			}
		}

		return { napi: { Transformer }, calls }
	}

	it('napiThumb resizes to the width and reports the original size', async () => {
		const { napi, calls } = fakeNapi()
		const result = await napiThumb(napi, Buffer.from('x'), 32)

		expect(result.original).toEqual({ width: 400, height: 200 })
		expect(result.buffer.toString()).toBe('jpeg')
		expect(calls).toContain('resize:32')
	})

	it('napiSquare crops a square from the corner and resizes', async () => {
		const { napi, calls } = fakeNapi()
		const buffer = await napiSquare(napi, Buffer.from('x'), 640, 640)

		expect(buffer.toString()).toBe('jpeg')
		expect(calls).toEqual(expect.arrayContaining(['crop:0,0,200,200', 'resize:640x640', 'jpeg:50']))
	})
})

describe('buildVideoThumbArgs', () => {
	it('keeps every path as one argument, even with spaces or shell characters', () => {
		const path = '/tmp/my video; rm -rf ~ $(x).mp4'
		const dest = '/tmp/out thumb.jpg'
		const args = buildVideoThumbArgs(path, dest, '00:00:00', { width: 32, height: 32 })

		expect(args).toEqual([
			'-ss',
			'00:00:00',
			'-i',
			path,
			'-y',
			'-vf',
			'scale=32:-1',
			'-vframes',
			'1',
			'-f',
			'image2',
			dest
		])
	})
})
