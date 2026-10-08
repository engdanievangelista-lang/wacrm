import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((s: string) => `dec:${s}`),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendReactionMessage: vi.fn(),
}))

import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import type { WhatsAppConfig } from '@/types'
import {
  assertSupports,
  getProvider,
  UnsupportedByProviderError,
} from './index'
import type { ProviderFeature } from './types'

const features: ProviderFeature[] = [
  'templates',
  'interactive',
  'broadcast',
  'automations',
]

describe('assertSupports', () => {
  it.each(features)('meta supports %s', (f) => {
    expect(() => assertSupports({ provider: 'meta' }, f)).not.toThrow()
  })

  it.each(features)('uazapi throws for %s', (f) => {
    let err: unknown
    try {
      assertSupports({ provider: 'uazapi' }, f)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnsupportedByProviderError)
    expect((err as UnsupportedByProviderError).feature).toBe(f)
    expect((err as UnsupportedByProviderError).provider).toBe('uazapi')
  })

  it('does not decrypt', () => {
    vi.mocked(decrypt).mockClear()
    assertSupports({ provider: 'meta' }, 'templates')
    expect(decrypt).not.toHaveBeenCalled()
  })
})

describe('getProvider', () => {
  it('builds a meta provider with decrypted token', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'm1' })
    const p = getProvider({
      provider: 'meta',
      phone_number_id: 'pn1',
      access_token: 'enc',
    } as WhatsAppConfig)
    expect(p.id).toBe('meta')
    await p.sendText({ to: '1', text: 't' })
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'pn1', accessToken: 'dec:enc' }),
    )
  })

  it('throws for uazapi until adapter exists', () => {
    expect(() =>
      getProvider({ provider: 'uazapi', access_token: 'x' } as WhatsAppConfig),
    ).toThrow(/uazapi/i)
  })
})
