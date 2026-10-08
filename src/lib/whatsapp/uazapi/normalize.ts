import type { InboundContent, InboundMessage } from '@/lib/whatsapp/inbound/persist'
import type { StatusUpdate } from '@/lib/whatsapp/inbound/status'
import { toState, type InstanceState } from './instance'

/** Loose shape of `message` in a UAZAPI `messages` webhook. All fields optional. */
export interface UazapiMessage {
  id?: string
  messageid?: string
  chatid?: string
  sender?: string
  senderName?: string
  fromMe?: boolean
  wasSentByApi?: boolean
  isGroup?: boolean
  messageType?: string
  text?: string
  messageTimestamp?: number
  quoted?: string
  reaction?: string
  content?: unknown
  fileURL?: string
  status?: string
  [key: string]: unknown
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const
const TEXT_TYPES = ['conversation', 'extendedtext', 'text']

/** Phone digits from a 1:1 chatid, or null for groups/lids/newsletters/bad ids. */
function phoneFromChatId(chatid: string): string | null {
  const lower = chatid.toLowerCase()
  if (lower.endsWith('@g.us') || lower.endsWith('@lid') || lower.endsWith('@newsletter')) {
    return null
  }
  const local = lower.endsWith('@s.whatsapp.net') ? lower.slice(0, -'@s.whatsapp.net'.length) : lower
  return /^\d{8,15}$/.test(local) ? local : null
}

export function normalizeMessagesEvent(
  body: unknown,
  deps: { loadMedia: (m: UazapiMessage) => Promise<InboundContent> },
): InboundMessage | null {
  try {
    const root = asRecord(body)
    const message = asRecord(root?.message) as UazapiMessage | null
    if (!message) return null
    if (message.fromMe || message.isGroup) return null

    const chatid = str(message.chatid)
    if (!chatid) return null
    const phone = phoneFromChatId(chatid)
    if (!phone) return null

    const messageid = str(message.messageid)
    const idTail = str(message.id)?.split(':').pop()
    const externalId = messageid || idTail
    if (!externalId) return null

    const ts = typeof message.messageTimestamp === 'number' ? message.messageTimestamp : NaN
    const timestampSec = Number.isFinite(ts)
      ? Math.floor(ts / 1000)
      : Math.floor(Date.now() / 1000)

    const messageType = str(message.messageType) ?? ''
    const typeLower = messageType.toLowerCase()
    const text = str(message.text)

    const base = {
      externalId,
      identity: {
        phone,
        waUserId: null,
        waParentUserId: null,
        waUsername: null,
        name: str(message.senderName) ?? '',
      },
      timestampSec,
      replyToExternalId: str(message.quoted) || null,
    }

    const textContent = async (): Promise<InboundContent> => ({
      contentText: text ?? null,
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    })

    if (typeLower.includes('reaction')) {
      return {
        ...base,
        rawType: 'text',
        reaction: { targetExternalId: str(message.reaction) ?? '', emoji: text ?? '' },
        loadContent: textContent,
      }
    }

    const media = MEDIA_TYPES.find((t) => typeLower.includes(t))
    if (media) {
      return { ...base, rawType: media, loadContent: () => deps.loadMedia(message) }
    }

    if (TEXT_TYPES.includes(typeLower)) {
      return { ...base, rawType: 'text', loadContent: textContent }
    }

    return {
      ...base,
      rawType: 'text',
      fallbackText: text || `[${messageType || 'unknown'}]`,
      loadContent: textContent,
    }
  } catch {
    return null
  }
}

export function normalizeUpdateEvent(body: unknown): StatusUpdate[] {
  try {
    const root = asRecord(body)
    if (!root || root.type !== 'ReadReceipt') return []
    const state = str(root.state)?.toLowerCase()
    const status = state === 'delivered' ? 'delivered' : state === 'read' || state === 'played' ? 'read' : null
    if (!status) return []
    const event = asRecord(root.event)
    const ids = event?.MessageIDs
    if (!event || !Array.isArray(ids)) return []
    const ts = event.Timestamp
    const timestampSec =
      typeof ts === 'number' && Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000)
    return ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((externalId) => ({ externalId, status, timestampSec }))
  } catch {
    return []
  }
}

export function normalizeConnectionEvent(body: unknown): { state: InstanceState } | null {
  try {
    const instance = asRecord(asRecord(body)?.instance)
    const status = instance?.status
    if (typeof status !== 'string' || !status) return null
    return { state: toState(status) }
  } catch {
    return null
  }
}
