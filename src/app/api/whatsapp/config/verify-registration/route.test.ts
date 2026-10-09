import { beforeEach, describe, expect, it, vi } from 'vitest'

let configRow: Record<string, unknown> | null = null

function makeDb() {
  const result = (table: string) =>
    table === 'profiles'
      ? { data: { account_id: 'acct-1' }, error: null }
      : { data: configRow, error: null }
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) b[m] = vi.fn(() => b)
      b.maybeSingle = vi.fn(async () => result(table))
      return b
    }),
  }
}

let db = makeDb()
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => db) }))
const decryptMock = vi.hoisted(() => vi.fn<(v: string) => string>(() => 'plaintext-token'))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: decryptMock }))
const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
  getSubscribedApps: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => [{ id: 'app' }]),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)
const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
vi.stubGlobal('fetch', fetchSpy)

import { GET } from './route'

const BASE = {
  account_id: 'acct-1',
  phone_number_id: 'PNID-1',
  waba_id: 'WABA-1',
  access_token: 'enc-secret-token',
  registered_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  db = makeDb()
  decryptMock.mockClear()
  meta.verifyPhoneNumber.mockClear()
  meta.getSubscribedApps.mockClear()
  fetchSpy.mockClear()
})

describe('GET /config/verify-registration', () => {
  it('returns not-applicable for a uazapi row without touching Meta, decrypt or fetch', async () => {
    configRow = { ...BASE, provider: 'uazapi', phone_number_id: null, waba_id: null }
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      live: false,
      checks: { config_exists: true },
      message: 'Not applicable to this provider.',
    })
    expect(decryptMock).not.toHaveBeenCalled()
    expect(meta.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(meta.getSubscribedApps).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    const text = JSON.stringify(body) + JSON.stringify(logs.mock.calls)
    expect(text).not.toContain('plaintext-token')
    expect(text).not.toContain('enc-secret-token')
    logs.mockRestore()
  })

  it.each([
    ['meta', { ...BASE, provider: 'meta' }],
    ['no provider field', { ...BASE }],
  ])('still runs the Meta checks for %s', async (_n, row) => {
    configRow = row
    const res = await GET()
    const body = await res.json()
    expect(decryptMock).toHaveBeenCalledWith('enc-secret-token')
    expect(meta.verifyPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: 'PNID-1',
      accessToken: 'plaintext-token',
    })
    expect(meta.getSubscribedApps).toHaveBeenCalledWith({
      wabaId: 'WABA-1',
      accessToken: 'plaintext-token',
    })
    expect(body.live).toBe(true)
  })
})
