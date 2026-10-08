import { describe, it, expect, vi } from 'vitest'
import {
  normalizeMessagesEvent,
  normalizeUpdateEvent,
  normalizeConnectionEvent,
} from './normalize'

const media = { contentText: 'm', mediaUrl: 'u', mediaType: 'image', interactiveReplyId: null }

function deps() {
  return { loadMedia: vi.fn().mockResolvedValue(media) }
}

function msgBody(over: Record<string, unknown> = {}) {
  return {
    EventType: 'messages',
    owner: '5511999999999',
    message: {
      id: '5511999999999:MSG_EXEMPLO',
      messageid: 'MSG_EXEMPLO',
      chatid: '5511888888888@s.whatsapp.net',
      sender: '5511888888888@s.whatsapp.net',
      senderName: 'Contato de exemplo',
      fromMe: false,
      isGroup: false,
      messageType: 'Conversation',
      text: 'Olá, preciso de ajuda.',
      messageTimestamp: 1788868800000,
      ...over,
    },
  }
}

describe('normalizeMessagesEvent', () => {
  it('maps a text message', async () => {
    const d = deps()
    const m = normalizeMessagesEvent(msgBody(), d)!
    expect(m.externalId).toBe('MSG_EXEMPLO')
    expect(m.identity).toEqual({
      phone: '5511888888888',
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
      name: 'Contato de exemplo',
    })
    expect(m.timestampSec).toBe(1788868800)
    expect(m.rawType).toBe('text')
    expect(m.replyToExternalId).toBeNull()
    expect(await m.loadContent()).toEqual({
      contentText: 'Olá, preciso de ajuda.',
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    })
    expect(d.loadMedia).not.toHaveBeenCalled()
  })

  it('falls back to id suffix when messageid is missing, null when neither', () => {
    expect(normalizeMessagesEvent(msgBody({ messageid: undefined }), deps())!.externalId).toBe(
      'MSG_EXEMPLO',
    )
    expect(
      normalizeMessagesEvent(msgBody({ messageid: undefined, id: undefined }), deps()),
    ).toBeNull()
  })

  it('ignores fromMe, groups, lid, newsletter and non-numeric chats', () => {
    expect(normalizeMessagesEvent(msgBody({ fromMe: true }), deps())).toBeNull()
    expect(normalizeMessagesEvent(msgBody({ isGroup: true }), deps())).toBeNull()
    expect(
      normalizeMessagesEvent(msgBody({ chatid: '120363000000001@g.us' }), deps()),
    ).toBeNull()
    expect(normalizeMessagesEvent(msgBody({ chatid: '300001@lid' }), deps())).toBeNull()
    expect(
      normalizeMessagesEvent(msgBody({ chatid: '120363123@newsletter' }), deps()),
    ).toBeNull()
    expect(
      normalizeMessagesEvent(msgBody({ chatid: 'abc@s.whatsapp.net' }), deps()),
    ).toBeNull()
    expect(
      normalizeMessagesEvent(msgBody({ chatid: '123@s.whatsapp.net' }), deps()),
    ).toBeNull()
  })

  it('accepts a bare digit chatid', () => {
    expect(normalizeMessagesEvent(msgBody({ chatid: '5511888888888' }), deps())!.identity.phone).toBe(
      '5511888888888',
    )
  })

  it('carries quoted id; empty quoted is null', () => {
    expect(normalizeMessagesEvent(msgBody({ quoted: 'ABC' }), deps())!.replyToExternalId).toBe('ABC')
    expect(normalizeMessagesEvent(msgBody({ quoted: '' }), deps())!.replyToExternalId).toBeNull()
  })

  it('loads media only when loadContent is invoked', async () => {
    const d = deps()
    const m = normalizeMessagesEvent(msgBody({ messageType: 'ImageMessage' }), d)!
    expect(m.rawType).toBe('image')
    expect(d.loadMedia).not.toHaveBeenCalled()
    expect(await m.loadContent()).toEqual(media)
    expect(d.loadMedia).toHaveBeenCalledTimes(1)
    for (const [t, r] of [
      ['videoMessage', 'video'],
      ['AudioMessage', 'audio'],
      ['documentMessage', 'document'],
      ['stickerMessage', 'sticker'],
    ]) {
      expect(normalizeMessagesEvent(msgBody({ messageType: t }), deps())!.rawType).toBe(r)
    }
  })

  it('maps reactions', () => {
    const m = normalizeMessagesEvent(
      msgBody({ messageType: 'ReactionMessage', text: '👍', reaction: 'TARGET' }),
      deps(),
    )!
    expect(m.reaction).toEqual({ targetExternalId: 'TARGET', emoji: '👍' })
  })

  it('drops messages sent by the API', () => {
    expect(
      normalizeMessagesEvent(msgBody({ wasSentByApi: true, fromMe: false }), deps()),
    ).toBeNull()
  })

  it('unknown types fall back to text with fallbackText', async () => {
    const a = normalizeMessagesEvent(msgBody({ messageType: 'LocationMessage', text: '' }), deps())!
    expect(a.rawType).toBe('text')
    expect(a.fallbackText).toBe('[LocationMessage]')
    expect((await a.loadContent()).contentText).toBeNull()
    const b = normalizeMessagesEvent(msgBody({ messageType: 'LocationMessage', text: 'hi' }), deps())!
    expect(b.fallbackText).toBe('hi')
  })

  it('never throws on garbage', () => {
    for (const g of [null, undefined, 5, 'x', [], {}, { message: 5 }, { message: null }]) {
      expect(normalizeMessagesEvent(g, deps())).toBeNull()
    }
  })
})

describe('normalizeUpdateEvent', () => {
  const read = {
    EventType: 'messages_update',
    type: 'ReadReceipt',
    state: 'Read',
    event: { MessageIDs: ['MSG_EXEMPLO'], Timestamp: 1788868800, Type: 'Read' },
  }

  it('maps a read receipt', () => {
    expect(normalizeUpdateEvent(read)).toEqual([
      { externalId: 'MSG_EXEMPLO', status: 'read', timestampSec: 1788868800 },
    ])
  })

  it('maps Delivered and Played, ignores other states', () => {
    expect(normalizeUpdateEvent({ ...read, state: 'Delivered' })[0].status).toBe('delivered')
    expect(normalizeUpdateEvent({ ...read, state: 'played' })[0].status).toBe('read')
    expect(normalizeUpdateEvent({ ...read, state: 'Sent' })).toEqual([])
  })

  it('handles null MessageIDs, GroupReceipts, multiple ids and missing timestamp', () => {
    expect(normalizeUpdateEvent({ ...read, event: { MessageIDs: null } })).toEqual([])
    expect(normalizeUpdateEvent({ ...read, type: 'GroupReceipts' })).toEqual([])
    expect(normalizeUpdateEvent({ ...read, event: { MessageIDs: ['a', 'b'] } })).toHaveLength(2)
    const t = normalizeUpdateEvent({ ...read, event: { MessageIDs: ['a'] } })[0].timestampSec
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5)
  })

  it('never throws on garbage', () => {
    for (const g of [null, undefined, 5, 'x', [], {}, { type: 'ReadReceipt', event: 3 }]) {
      expect(normalizeUpdateEvent(g)).toEqual([])
    }
  })
})

describe('normalizeConnectionEvent', () => {
  it('maps connected / disconnected', () => {
    expect(
      normalizeConnectionEvent({ EventType: 'connection', instance: { status: 'connected' } }),
    ).toEqual({ state: 'connected' })
    expect(
      normalizeConnectionEvent({
        EventType: 'connection',
        instance: { status: 'disconnected', lastDisconnectReason: 'x' },
      }),
    ).toEqual({ state: 'disconnected' })
  })

  it('coerces unknown to disconnected; null without status', () => {
    expect(normalizeConnectionEvent({ instance: { status: 'weird' } })).toEqual({
      state: 'disconnected',
    })
    expect(normalizeConnectionEvent({ instance: {} })).toBeNull()
    expect(normalizeConnectionEvent({})).toBeNull()
    expect(normalizeConnectionEvent(null)).toBeNull()
    expect(normalizeConnectionEvent('x')).toBeNull()
  })
})
