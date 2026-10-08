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
  connectInstance: vi.fn(),
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
  connectInstance: h.connectInstance,
  getInstanceStatus: vi.fn(),
  createInstance: vi.fn(),
  configureWebhook: vi.fn(),
  deleteInstance: vi.fn(),
  disconnectInstance: vi.fn(),
}))

import { POST } from './route'

async function call() {
  const res = await POST()
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

describe('POST /api/whatsapp/uazapi/connect', () => {
  it('starts the QR flow and returns { qr, state }', async () => {
    h.connectInstance.mockResolvedValue({ qr: 'data:image/png;base64,AAA', state: 'connecting' })
    const { res, json } = await call()
    expect(res.status).toBe(200)
    expect(json).toEqual({ qr: 'data:image/png;base64,AAA', state: 'connecting' })
    expect(h.connectInstance).toHaveBeenCalledWith(INSTANCE_TOKEN)
    expectNoSecrets(json)
  })

  it('tolerates a connect response without a QR', async () => {
    h.connectInstance.mockResolvedValue({ qr: null, state: 'connecting' })
    const { res, json } = await call()
    expect(res.status).toBe(200)
    expect(json).toEqual({ qr: null, state: 'connecting' })
  })

  it('moves a disconnected row back to connecting', async () => {
    h.configRow = { ...h.configRow, status: 'disconnected' }
    h.connectInstance.mockResolvedValue({ qr: null, state: 'connecting' })
    const { res } = await call()
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].payload).toMatchObject({ status: 'connecting' })
    expect(h.updates[0].eqs).toContainEqual(['account_id', 'acct-1'])
  })

  it('400s when the account has no UAZAPI config', async () => {
    h.configRow = null
    const { res, json } = await call()
    expect(res.status).toBe(400)
    expect(json.error).toBeTruthy()
    expect(h.connectInstance).not.toHaveBeenCalled()
  })

  it('400s when the account config is Meta', async () => {
    h.configRow = { id: 'cfg-1', provider: 'meta', status: 'connected', access_token: encrypt('m') }
    const { res } = await call()
    expect(res.status).toBe(400)
    expect(h.connectInstance).not.toHaveBeenCalled()
  })

  it('marks a deleted instance (404) disconnected and tells the user to recreate it', async () => {
    h.connectInstance.mockRejectedValue(new UazapiError('UAZAPI POST /instance/connect failed with status 404', 404))
    const { res, json } = await call()
    expect(res.status).toBe(409)
    expect(json.state).toBe('disconnected')
    expect(h.updates[0]?.payload).toMatchObject({ status: 'disconnected' })
    expectNoSecrets(json)
  })

  it('returns a generic 502 on a network failure', async () => {
    h.connectInstance.mockRejectedValue(new TypeError('fetch failed https://uaz.example.test'))
    const { res, json } = await call()
    expect(res.status).toBe(502)
    expect(JSON.stringify(json)).not.toContain('uaz.example.test')
  })

  it('maps a vendor 429 to 429 with Retry-After', async () => {
    h.connectInstance.mockRejectedValue(new UazapiError('rate limited', 429, 3))
    const { res } = await call()
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('3')
  })

  it('rejects unauthenticated callers', async () => {
    h.authed = false
    const { res } = await call()
    expect(res.status).toBe(401)
    expect(h.connectInstance).not.toHaveBeenCalled()
  })

  it('rejects non-admin members', async () => {
    h.role = 'viewer'
    const { res } = await call()
    expect(res.status).toBe(403)
    expect(h.connectInstance).not.toHaveBeenCalled()
  })
})
