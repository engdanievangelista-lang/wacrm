import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendReactionMessage: vi.fn(),
}))

import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api'
import { createMetaProvider } from './meta'

const creds = { phoneNumberId: 'pn1', accessToken: 'tok' }

describe('createMetaProvider', () => {
  beforeEach(() => vi.clearAllMocks())

  it('declares meta id and full capabilities', () => {
    const p = createMetaProvider(creds)
    expect(p.id).toBe('meta')
    expect(p.supports).toEqual({
      templates: true,
      interactive: true,
      broadcast: true,
      automations: true,
    })
  })

  it('sendText maps args and returns messageId', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'wamid.1' })
    const r = await createMetaProvider(creds).sendText({
      to: '5511',
      text: 'hi',
      replyToMessageId: 'wamid.0',
    })
    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn1',
      accessToken: 'tok',
      to: '5511',
      text: 'hi',
      contextMessageId: 'wamid.0',
    })
    expect(r).toEqual({ messageId: 'wamid.1' })
  })

  it('sendMedia maps url to link', async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({ messageId: 'wamid.2' })
    const r = await createMetaProvider(creds).sendMedia({
      to: '5511',
      kind: 'document',
      url: 'https://x/y.pdf',
      caption: 'c',
      filename: 'y.pdf',
      replyToMessageId: 'wamid.0',
    })
    expect(sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn1',
      accessToken: 'tok',
      to: '5511',
      kind: 'document',
      link: 'https://x/y.pdf',
      caption: 'c',
      filename: 'y.pdf',
      contextMessageId: 'wamid.0',
    })
    expect(r).toEqual({ messageId: 'wamid.2' })
  })

  it('sendReaction maps messageId to targetMessageId', async () => {
    vi.mocked(sendReactionMessage).mockResolvedValue({ messageId: 'wamid.3' })
    const r = await createMetaProvider(creds).sendReaction({
      to: '5511',
      messageId: 'wamid.9',
      emoji: '👍',
    })
    expect(sendReactionMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn1',
      accessToken: 'tok',
      to: '5511',
      targetMessageId: 'wamid.9',
      emoji: '👍',
    })
    expect(r).toBeUndefined()
  })
})
