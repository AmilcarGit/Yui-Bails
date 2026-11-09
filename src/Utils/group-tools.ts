import { Boom } from '@hapi/boom'
import type { GroupMetadata, GroupParticipant, ParticipantAction, WAMessage } from '../Types'
import { jidDecode } from '../WABinary'
import type { GroupMetadataCache } from './group-cache'
import type { SenderInfo } from './helpers'

/** Who to check or act on: a number, a jid, a message, or the result of `getSender` */
export type GroupMember = string | WAMessage | SenderInfo

export type GroupToolsSocket = {
	user?: { id: string; lid?: string } | undefined
	groupMetadata: (jid: string) => Promise<GroupMetadata>
	groupParticipantsUpdate: (jid: string, participants: string[], action: ParticipantAction) => Promise<unknown>
}

/** the user part of a jid, or the digits of a phone number */
const identity = (value: string | undefined) => {
	if (!value) return undefined
	return value.includes('@') ? jidDecode(value)?.user : value.replace(/\D/g, '') || undefined
}

const identitiesOf = (participant: Pick<GroupParticipant, 'id' | 'lid' | 'phoneNumber'>) =>
	[participant.id, participant.lid, participant.phoneNumber].map(identity).filter((entry): entry is string => !!entry)

const isAdminParticipant = (participant: GroupParticipant) =>
	!!(participant.admin || participant.isAdmin || participant.isSuperAdmin)

/** a number ("+51 910 227 479") or a jid becomes a jid */
const toJid = (value: string) => (value.includes('@') ? value : `${value.replace(/\D/g, '')}@s.whatsapp.net`)

/**
 * Group permissions and moderation shortcuts that understand both identities WhatsApp uses
 * (phone number and LID), so admin checks do not break when a group shows LIDs.
 */
export const makeGroupTools = (
	sock: GroupToolsSocket,
	{ cache, getSender }: { cache?: GroupMetadataCache; getSender: (msg: WAMessage) => Promise<SenderInfo> }
) => {
	const metadata = async (groupJid: string) => {
		const cached = cache?.get(groupJid)
		if (cached) return cached

		const fresh = await sock.groupMetadata(groupJid)
		cache?.set(groupJid, fresh)
		return fresh
	}

	/** every identity (number, LID id) a member is known by */
	const identitiesOfMember = async (who: GroupMember): Promise<string[]> => {
		if (typeof who === 'string') return [identity(who)].filter((entry): entry is string => !!entry)

		const sender = 'key' in who ? await getSender(who) : who
		return [sender.number, sender.id].filter((entry): entry is string => !!entry)
	}

	const targets = (who: string | string[]) => (Array.isArray(who) ? who : [who]).map(toJid)

	const act = async (groupJid: string, who: string | string[], action: ParticipantAction) => {
		const jids = targets(who)
		if (!jids.length) throw new Boom('Say who to act on', { statusCode: 400 })

		const result = await sock.groupParticipantsUpdate(groupJid, jids, action)
		cache?.delete(groupJid) // the member list just changed
		return result
	}

	return {
		/** Admins and super admins of a group. */
		getAdmins: async (groupJid: string) => (await metadata(groupJid)).participants.filter(isAdminParticipant),

		/** Is this person (number, jid, message or sender) an admin of the group? */
		isAdmin: async (groupJid: string, who: GroupMember) => {
			const wanted = await identitiesOfMember(who)
			if (!wanted.length) return false

			const { participants } = await metadata(groupJid)
			return participants
				.filter(isAdminParticipant)
				.some(participant => identitiesOf(participant).some(entry => wanted.includes(entry)))
		},

		/** Is the bot itself an admin of the group? */
		isBotAdmin: async (groupJid: string) => {
			const me = [sock.user?.id, sock.user?.lid].map(identity).filter((entry): entry is string => !!entry)
			if (!me.length) return false

			const { participants } = await metadata(groupJid)
			return participants
				.filter(isAdminParticipant)
				.some(participant => identitiesOf(participant).some(entry => me.includes(entry)))
		},

		/** Removes members (numbers or jids). The bot must be admin. */
		kick: (groupJid: string, who: string | string[]) => act(groupJid, who, 'remove'),
		/** Adds members. */
		addMembers: (groupJid: string, who: string | string[]) => act(groupJid, who, 'add'),
		/** Makes members admins. */
		promote: (groupJid: string, who: string | string[]) => act(groupJid, who, 'promote'),
		/** Removes admin rights. */
		demote: (groupJid: string, who: string | string[]) => act(groupJid, who, 'demote')
	}
}

export type GroupTools = ReturnType<typeof makeGroupTools>
