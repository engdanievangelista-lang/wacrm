import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// Pins: a UAZAPI failure must never trigger the Meta phone-variant retry
// (which would risk sending the message twice).
const sendText = vi.fn()

vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers')
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      id: 'mock',
      supports: {},
      sendText,
      sendMedia: vi.fn(),
      sendReaction: vi.fn(),
    })),
  }
})
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plain-token'),
  encrypt: vi.fn((v: string) => v),
  isLegacyFormat: vi.fn(() => false),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('not used')
  },
}))

import { sendMessageToConversation, SendMessageError } from './send-message'
import { UazapiError } from './uazapi/client'

function makeDb(): SupabaseClient {
  const results: Record<string, unknown> = {
    conversations: { id: 'cv-1', contact: { id: 'ct-1', phone: '5511999990000' } },
    whatsapp_config: { id: 'cfg-1', provider: 'uazapi', phone_number_id: null, access_token: 'enc' },
  }
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'insert', 'update']) chain[m] = () => chain
      chain.single = async () => ({ data: results[table], error: null })
      chain.maybeSingle = chain.single
      return chain
    },
  } as unknown as SupabaseClient
}

describe('UAZAPI failures never trigger the phone-variant retry', () => {
  beforeEach(() => {
    sendText.mockReset()
  })

  it.each([
    ['non-JSON response', () => new UazapiError('UAZAPI POST /send/text returned a non-JSON response', 200)],
    ['status 500', () => new UazapiError('UAZAPI POST /send/text failed with status 500', 500)],
    ['timeout', () => new UazapiError('UAZAPI POST /send/text timed out', 504)],
  ])('%s: sendText called once, provider_error', async (_n, makeError) => {
    sendText.mockImplementation(async () => {
      throw makeError()
    })
    const err = await sendMessageToConversation(makeDb(), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e)
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(SendMessageError)
    expect(err.code).toBe('provider_error')
  })
})
