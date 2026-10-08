import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UazapiError } from '@/lib/whatsapp/uazapi/client'
import { encrypt } from '@/lib/whatsapp/encryption'

const ADMIN_TOKEN = 'admintoken-secret-xyz'
const INSTANCE_TOKEN = 'inst-token-0123456789abcdef'

type Rec = Record<string, unknown>

const h = vi.hoisted(() => ({
  authed: true,
  role: 'admin' as string | null,
  configRow: null as Record<string, unknown> | null,
  updates: [] as { payload: Record<string, unknown>; eqs: [string, unknown][] }[],
  getInstanceStatus: vi.fn(),
}))

function builder(table: string) {
  let op: 'select' | 'update' = 'select'
  let payload: Rec = {}
  const eqs: [string, unknown][] = []
  const result = () => {
    switch (table) {
      case 'profiles':
        return {
          data: h.role ? { account_id: 'acct-1', account_role: h.role } : null,
          error: null,
        }
      case 'accounts':
        return { data: { id: 'acct-1', name: 'Acme' }, error: null }
      case 'whatsapp_config':
        if (op === 'update') {
          h.updates.push({ payload, eqs })
          return { data: null, error: null }
        }
        return { data: h.configRow, error: null }
      default:
        return { data: null, error: null }
    }
  }
  const b: Rec = {}
  b.select = vi.fn(() => b)
  b.eq = vi.fn((col: string, val: unknown) => {
    eqs.push([col, val])
    return b
  })
  b.update = vi.fn((p: Rec) => {
    op = 'update'
    payload = p
    return b
  })
  b.maybeSingle = vi.fn(async () => result())
  b.single = vi.fn(async () => result())
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve)
  return b
}

const supabaseMock = {
  auth: {
    getUser: vi.fn(async () =>
      h.authed
        ? { data: { user: { id: 'user-1' } }, error: null }
        : { data: { user: null }, error: null },
    ),
  },
  from: vi.fn((table: string) => builder(table)),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/whatsapp/uazapi/instance', () => ({
  getInstanceStatus: h.getInstanceStatus,
  connectInstance: vi.fn(),
  createInstance: vi.fn(),
  configureWebhook: vi.fn(),
  deleteInstance: vi.fn(),
  disconnectInstance: vi.fn(),
}))

import { GET } from './route'

async function call() {
  const res = await GET()
  return { res, json: (await res.json()) as Rec }
}

function expectNoSecrets(json: unknown) {
  const s = JSON.stringify(json)
  expect(s).not.toContain(INSTANCE_TOKEN)
  expect(s).not.toContain(ADMIN_TOKEN)
  expect(s).not.toContain('whsec-secret')
  expect(s).not.toMatch(/access_token|webhook_secret|admintoken/i)
}

beforeEach(() => {
  h.authed = true
  h.role = 'admin'
  h.updates.length = 0
  vi.stubEnv('UAZAPI_URL', 'https://uaz.example.test')
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', ADMIN_TOKEN)
  h.configRow = {
    id: 'cfg-1',
    provider: 'uazapi',
    status: 'connecting',
    access_token: encrypt(INSTANCE_TOKEN),
    webhook_secret: 'whsec-secret',
    provider_config: { instance_id: 'inst-1' },
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/whatsapp/uazapi/status', () => {
  it('persists phone/profile and status on connected', async () => {
    h.getInstanceStatus.mockResolvedValue({
      state: 'connected',
      qr: null,
      phone: '5511999999999',
      profileName: 'Acme',
    })
    const { res, json } = await call()
    expect(res.status).toBe(200)
    expect(json).toEqual({ state: 'connected', qr: null, phone: '5511999999999', profileName: 'Acme' })
    expect(h.getInstanceStatus).toHaveBeenCalledWith(INSTANCE_TOKEN)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].eqs).toContainEqual(['account_id', 'acct-1'])
    expect(h.updates[0].payload).toMatchObject({
      status: 'connected',
      provider_config: { instance_id: 'inst-1', phone: '5511999999999', profile_name: 'Acme' },
    })
    expectNoSecrets(json)
  })

  it('is idempotent once connected with the same phone/profile', async () => {
    h.configRow = {
      ...h.configRow,
      status: 'connected',
      provider_config: { instance_id: 'inst-1', phone: '5511999999999', profile_name: 'Acme' },
    }
    h.getInstanceStatus.mockResolvedValue({
      state: 'connected',
      qr: null,
      phone: '5511999999999',
      profileName: 'Acme',
    })
    const { res } = await call()
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(0)
  })

  it('returns the QR while connecting without changing status', async () => {
    h.getInstanceStatus.mockResolvedValue({
      state: 'connecting',
      qr: 'data:image/png;base64,AAA',
      phone: null,
      profileName: null,
    })
    const { res, json } = await call()
    expect(res.status).toBe(200)
    expect(json).toEqual({ state: 'connecting', qr: 'data:image/png;base64,AAA', phone: null, profileName: null })
    expect(h.updates).toHaveLength(0)
  })

  it('marks the row disconnected when the instance reports disconnected', async () => {
    h.getInstanceStatus.mockResolvedValue({ state: 'disconnected', qr: null, phone: null, profileName: null })
    const { res } = await call()
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].payload).toMatchObject({ status: 'disconnected' })
  })

  it.each([401, 404])('treats a UAZAPI %i as a deleted instance: disconnected, not 500', async (status) => {
    h.getInstanceStatus.mockRejectedValue(new UazapiError(`UAZAPI GET /instance/status failed with status ${status}`, status))
    const { res, json } = await call()
    expect(res.status).toBe(200)
    expect(json).toEqual({ state: 'disconnected', qr: null, phone: null, profileName: null })
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].payload).toMatchObject({ status: 'disconnected' })
    expect(h.updates[0].eqs).toContainEqual(['account_id', 'acct-1'])
  })

  it('returns a generic 502 on a network TypeError without leaking details', async () => {
    h.getInstanceStatus.mockRejectedValue(new TypeError('fetch failed https://uaz.example.test'))
    const { res, json } = await call()
    expect(res.status).toBe(502)
    expect(json.error).toBeTruthy()
    expect(JSON.stringify(json)).not.toContain('uaz.example.test')
    expect(h.updates).toHaveLength(0)
  })

  it('returns a generic 502 on other vendor errors', async () => {
    h.getInstanceStatus.mockRejectedValue(new UazapiError('UAZAPI GET /instance/status failed with status 500', 500))
    const { res } = await call()
    expect(res.status).toBe(502)
  })

  it('maps a vendor 429 to 429 with Retry-After', async () => {
    h.getInstanceStatus.mockRejectedValue(new UazapiError('rate limited', 429, 12))
    const { res, json } = await call()
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('12')
    expect(String(json.error)).toMatch(/too many|rate/i)
  })

  it('400s when the account has no UAZAPI config', async () => {
    h.configRow = { id: 'cfg-1', provider: 'meta', status: 'connected', access_token: encrypt('m') }
    const { res } = await call()
    expect(res.status).toBe(400)
    expect(h.getInstanceStatus).not.toHaveBeenCalled()
  })

  it('400s when the account has no config at all', async () => {
    h.configRow = null
    const { res } = await call()
    expect(res.status).toBe(400)
  })

  it('rejects unauthenticated callers', async () => {
    h.authed = false
    const { res } = await call()
    expect(res.status).toBe(401)
    expect(h.getInstanceStatus).not.toHaveBeenCalled()
  })

  it('rejects non-admin members', async () => {
    h.role = 'agent'
    const { res } = await call()
    expect(res.status).toBe(403)
    expect(h.getInstanceStatus).not.toHaveBeenCalled()
  })
})
