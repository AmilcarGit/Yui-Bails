import { jest } from '@jest/globals'
import type { GroupMetadata, WAMessage } from '../../Types'
import { makeGroupMetadataCache } from '../../Utils/group-cache'
import { type GroupToolsSocket, makeGroupTools } from '../../Utils/group-tools'
import { getSenderIds } from '../../Utils/helpers'

const GROUP = '1203@g.us'

// a LID group: members show up by LID, with their phone number as extra data
const metadata = {
	id: GROUP,
	participants: [
		{ id: '269715926691844@lid', phoneNumber: '51910227479@s.whatsapp.net', admin: 'superadmin' },
		{ id: '152652482646250@lid', phoneNumber: '51925679896@s.whatsapp.net', admin: null },
		{ id: '999000111@lid', lid: '999000111@lid', admin: 'admin' }
	]
} as unknown as GroupMetadata

const make = () => {
	const groupMetadata = jest.fn(async () => metadata)
	const groupParticipantsUpdate = jest.fn(async () => [])
	const sock = {
		user: { id: '51925679896:3@s.whatsapp.net', lid: '152652482646250:3@lid' },
		groupMetadata,
		groupParticipantsUpdate
	} as unknown as GroupToolsSocket
	const cache = makeGroupMetadataCache()
	const tools = makeGroupTools(sock, { cache, getSender: async msg => getSenderIds(msg) })
	return { tools, groupMetadata, groupParticipantsUpdate, cache }
}

describe('makeGroupTools', () => {
	it('lists the admins', async () => {
		const { tools } = make()
		expect((await tools.getAdmins(GROUP)).map(p => p.id)).toEqual(['269715926691844@lid', '999000111@lid'])
	})

	it('isAdmin matches by phone number, LID id, jid, message or sender', async () => {
		const { tools } = make()
		expect(await tools.isAdmin(GROUP, '51910227479')).toBe(true) // number, member listed by LID
		expect(await tools.isAdmin(GROUP, '+51 910 227 479')).toBe(true)
		expect(await tools.isAdmin(GROUP, '269715926691844@lid')).toBe(true)
		expect(await tools.isAdmin(GROUP, '999000111')).toBe(true)
		expect(await tools.isAdmin(GROUP, '51925679896')).toBe(false) // member, not admin
		expect(await tools.isAdmin(GROUP, '51900000000')).toBe(false) // not in the group

		const msg = { key: { remoteJid: GROUP, participant: '269715926691844@lid', id: 'A' } } as WAMessage
		expect(await tools.isAdmin(GROUP, msg)).toBe(true)
		expect(await tools.isAdmin(GROUP, getSenderIds(msg))).toBe(true)
		expect(await tools.isAdmin(GROUP, '')).toBe(false)
	})

	it('isBotAdmin looks at the bot account', async () => {
		const { tools } = make()
		expect(await tools.isBotAdmin(GROUP)).toBe(false) // the bot is a plain member here
	})

	it('asks WhatsApp once and then uses the cache', async () => {
		const { tools, groupMetadata } = make()
		await tools.getAdmins(GROUP)
		await tools.isAdmin(GROUP, '51910227479')
		expect(groupMetadata).toHaveBeenCalledTimes(1)
	})

	it('kick / addMembers / promote / demote turn numbers into jids and refresh the cache', async () => {
		const { tools, groupParticipantsUpdate, groupMetadata, cache } = make()
		await tools.getAdmins(GROUP)
		expect(cache.get(GROUP)).toBeDefined()

		await tools.kick(GROUP, '+51 900 000 000')
		await tools.addMembers(GROUP, ['51911111111', '51922222222@s.whatsapp.net'])
		await tools.promote(GROUP, '51911111111')
		await tools.demote(GROUP, '269715926691844@lid')

		expect(groupParticipantsUpdate.mock.calls).toEqual([
			[GROUP, ['51900000000@s.whatsapp.net'], 'remove'],
			[GROUP, ['51911111111@s.whatsapp.net', '51922222222@s.whatsapp.net'], 'add'],
			[GROUP, ['51911111111@s.whatsapp.net'], 'promote'],
			[GROUP, ['269715926691844@lid'], 'demote']
		])
		expect(cache.get(GROUP)).toBeUndefined()

		await tools.getAdmins(GROUP)
		expect(groupMetadata).toHaveBeenCalledTimes(2)
	})

	it('refuses to act on nobody', async () => {
		const { tools } = make()
		await expect(tools.kick(GROUP, [])).rejects.toThrow('Say who')
	})
})
