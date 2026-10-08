import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UazapiError } from '@/lib/whatsapp/uazapi/client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

// ---------------------------------------------------------------------------
// Provider-aware behaviour of /api/whatsapp/config (UAZAPI). The Meta path is
// covered elsewhere; here we only assert the additive fields on a Meta row.
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'admintoken-secret-xyz'
const INSTANCE_TOKEN = 'inst-token-0123456789abcdef'

type Rec = Record<string, unknown>

const h = vi.hoisted(() => ({
  authed: true,
  role: 'admin' as string | null,
  configRow: null as Record<string, unknown> | null,
  insertError: null as { message: string } | null,
  inserts: [] as Record<string, unknown>[],
  updates: [] as { payload: Record<string, unknown>; eqs: [string, unknown][] }[],
  deletes: [] as { eqs: [string, unknown][] }[],
  createInstance: vi.fn(),
  configureWebhook: vi.fn(),
  deleteInstance: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  getSubscribedApps: vi.fn(),
}))

function builder(table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
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
        if (op === 'insert') {
          if (!h.insertError) h.inserts.push(payload)
          return { data: null, error: h.insertError }
        }
        if (op === 'update') {
          h.updates.push({ payload, eqs })
          return { data: null, error: null }
        }
        if (op === 'delete') {
          h.deletes.push({ eqs })
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
  b.neq = vi.fn(() => b)
  b.insert = vi.fn((p: Rec) => {
    op = 'insert'
    payload = p
    return b
  })
  b.update = vi.fn((p: Rec) => {
    op = 'update'
    payload = p
    return b
  })
  b.delete = vi.fn(() => {
    op = 'delete'
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

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => supabaseMock),
}))

vi.mock('@/lib/whatsapp/uazapi/instance', () => ({
  createInstance: h.createInstance,
  configureWebhook: h.configureWebhook,
  deleteInstance: h.deleteInstance,
  connectInstance: vi.fn(),
  getInstanceStatus: vi.fn(),
  disconnectInstance: vi.fn(),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: h.verifyPhoneNumber,
  getSubscribedApps: h.getSubscribedApps,
  listWabaPhoneNumbers: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
}))

import { DELETE, GET, POST } from './route'

async function body(res: Response): Promise<Rec> {
  return (await res.json()) as Rec
}

function postJson(payload: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    }),
  )
}

function expectNoSecrets(json: unknown, extra: string[] = []) {
  const s = JSON.stringify(json)
  expect(s).not.toContain(INSTANCE_TOKEN)
  expect(s).not.toContain(ADMIN_TOKEN)
  expect(s).not.toMatch(/access_token|webhook_secret|admintoken/i)
  for (const e of extra) expect(s).not.toContain(e)
}

function enableUazapi() {
  vi.stubEnv('UAZAPI_URL', 'https://uaz.example.test')
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', ADMIN_TOKEN)
}

beforeEach(() => {
  h.authed = true
  h.role = 'admin'
  h.configRow = null
  h.insertError = null
  h.inserts.length = 0
  h.updates.length = 0
  h.deletes.length = 0
  vi.stubEnv('UAZAPI_URL', '')
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', '')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
  h.createInstance.mockResolvedValue({ instanceId: 'inst-1', token: INSTANCE_TOKEN })
  h.configureWebhook.mockResolvedValue(undefined)
  h.deleteInstance.mockResolvedValue(undefined)
  h.verifyPhoneNumber.mockResolvedValue({ display_phone_number: '+1 555 0100' })
  h.getSubscribedApps.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/whatsapp/config — providers', () => {
  it('only offers meta when UAZAPI is not configured, Meta row keeps its shape', async () => {
    h.configRow = {
      provider: 'meta',
      phone_number_id: '123',
      waba_id: '456',
      access_token: encrypt('meta-token'),
      status: 'connected',
    }
    const res = await GET()
    const json = await body(res)
    expect(res.status).toBe(200)
    expect(json.availableProviders).toEqual(['meta'])
    expect(json.provider).toBe('meta')
    expect(json.connected).toBe(true)
    expect(json.phone_info).toEqual({ display_phone_number: '+1 555 0100' })
    expect(json.waba_subscription).toBeDefined()
    expectNoSecrets(json, ['meta-token'])
  })

  it('reports availableProviders even with no config', async () => {
    enableUazapi()
    const json = await body(await GET())
    expect(json.connected).toBe(false)
    expect(json.reason).toBe('no_config')
    expect(json.availableProviders).toEqual(['meta', 'uazapi'])
  })

  it('returns status/phone/profileName for a UAZAPI row and no secrets', async () => {
    enableUazapi()
    h.configRow = {
      provider: 'uazapi',
      phone_number_id: null,
      waba_id: null,
      access_token: encrypt(INSTANCE_TOKEN),
      status: 'connected',
      webhook_secret: 'whsec-should-not-leak',
      provider_config: { instance_id: 'inst-1', phone: '5511999999999', profile_name: 'Acme' },
    }
    const res = await GET()
    const json = await body(res)
    expect(res.status).toBe(200)
    expect(json).toMatchObject({
      provider: 'uazapi',
      availableProviders: ['meta', 'uazapi'],
      status: 'connected',
      connected: true,
      phone: '5511999999999',
      profileName: 'Acme',
    })
    expect(h.verifyPhoneNumber).not.toHaveBeenCalled()
    expectNoSecrets(json, ['whsec-should-not-leak', String(h.configRow.access_token), 'inst-1'])
  })

  it('rejects unauthenticated callers', async () => {
    h.authed = false
    expect((await GET()).status).toBe(401)
  })
})

describe('POST /api/whatsapp/config — provider uazapi', () => {
  it('400s when UAZAPI is not enabled', async () => {
    const res = await postJson({ provider: 'uazapi' })
    const json = await body(res)
    expect(res.status).toBe(400)
    expect(String(json.error)).toMatch(/UAZAPI/i)
    expect(h.createInstance).not.toHaveBeenCalled()
  })

  it.each(['connected', 'connecting'])(
    '400s when an existing config is %s and never creates an instance',
    async (status) => {
      enableUazapi()
      h.configRow = { id: 'cfg-1', provider: 'meta', status, access_token: encrypt('x') }
      const res = await postJson({ provider: 'uazapi' })
      expect(res.status).toBe(400)
      expect(String((await body(res)).error)).toMatch(/disconnect/i)
      expect(h.createInstance).not.toHaveBeenCalled()
      expect(h.inserts).toHaveLength(0)
      expect(h.updates).toHaveLength(0)
    },
  )

  it('creates the instance, registers the webhook and stores an encrypted token', async () => {
    enableUazapi()
    const res = await postJson({ provider: 'uazapi' })
    const json = await body(res)
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, provider: 'uazapi', status: 'connecting' })

    expect(h.createInstance).toHaveBeenCalledTimes(1)
    const name = h.createInstance.mock.calls[0][0] as string
    expect(name).toContain('acct-1')

    expect(h.inserts).toHaveLength(1)
    const row = h.inserts[0]
    expect(row).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      provider: 'uazapi',
      status: 'connecting',
      phone_number_id: null,
      waba_id: null,
      provider_config: { instance_id: 'inst-1' },
    })
    expect(row.access_token).not.toBe(INSTANCE_TOKEN)
    expect(String(row.access_token)).not.toContain(INSTANCE_TOKEN)
    expect(decrypt(String(row.access_token))).toBe(INSTANCE_TOKEN)
    const secret = String(row.webhook_secret)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    expect(h.configureWebhook).toHaveBeenCalledWith(
      INSTANCE_TOKEN,
      `https://crm.example.test/api/whatsapp/uazapi/webhook/${secret}`,
    )
    expect(h.deleteInstance).not.toHaveBeenCalled()
    expectNoSecrets(json, [secret])
  })

  it('replaces a stale disconnected row instead of inserting', async () => {
    enableUazapi()
    h.configRow = { id: 'cfg-1', provider: 'meta', status: 'disconnected', access_token: encrypt('x') }
    const res = await postJson({ provider: 'uazapi' })
    expect(res.status).toBe(200)
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].eqs).toContainEqual(['account_id', 'acct-1'])
    expect(h.updates[0].payload).toMatchObject({
      provider: 'uazapi',
      status: 'connecting',
      phone_number_id: null,
      waba_id: null,
    })
  })

  it('deletes the new instance and inserts nothing when configureWebhook fails', async () => {
    enableUazapi()
    h.configureWebhook.mockRejectedValue(new UazapiError('UAZAPI POST /webhook failed with status 500', 500))
    const res = await postJson({ provider: 'uazapi' })
    const json = await body(res)
    expect(res.status).toBe(502)
    expect(json.error).toBeTruthy()
    expect(h.deleteInstance).toHaveBeenCalledWith(INSTANCE_TOKEN)
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    expectNoSecrets(json)
  })

  it('maps a vendor 429 on create to 429 with Retry-After', async () => {
    enableUazapi()
    h.createInstance.mockRejectedValue(new UazapiError('rate limited', 429, 7))
    const res = await postJson({ provider: 'uazapi' })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
  })

  it('returns a generic 502 for a network failure on create', async () => {
    enableUazapi()
    h.createInstance.mockRejectedValue(new TypeError('fetch failed https://uaz.example.test'))
    const res = await postJson({ provider: 'uazapi' })
    const json = await body(res)
    expect(res.status).toBe(502)
    expect(JSON.stringify(json)).not.toContain('uaz.example.test')
  })

  it('rejects unauthenticated callers', async () => {
    enableUazapi()
    h.authed = false
    const res = await postJson({ provider: 'uazapi' })
    expect(res.status).toBe(401)
    expect(h.createInstance).not.toHaveBeenCalled()
  })

  it('rejects non-admin members before touching UAZAPI', async () => {
    enableUazapi()
    h.role = 'agent'
    const res = await postJson({ provider: 'uazapi' })
    expect(res.status).toBe(403)
    expect(h.createInstance).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/whatsapp/config — uazapi row', () => {
  beforeEach(() => {
    enableUazapi()
    h.configRow = {
      id: 'cfg-1',
      provider: 'uazapi',
      status: 'connected',
      access_token: encrypt(INSTANCE_TOKEN),
    }
  })

  it('deletes the instance then removes the row', async () => {
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(h.deleteInstance).toHaveBeenCalledWith(INSTANCE_TOKEN)
    expect(h.deletes).toHaveLength(1)
    expect(h.deletes[0].eqs).toContainEqual(['account_id', 'acct-1'])
  })

  it('still removes the row when deleteInstance throws', async () => {
    h.deleteInstance.mockRejectedValue(new TypeError('fetch failed'))
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(h.deletes).toHaveLength(1)
    expectNoSecrets(await body(res))
  })

  it('does not call deleteInstance for a Meta row', async () => {
    h.configRow = { id: 'cfg-1', provider: 'meta', status: 'connected', access_token: encrypt('m') }
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(h.deleteInstance).not.toHaveBeenCalled()
    expect(h.deletes).toHaveLength(1)
  })

  it('refuses non-admins without deleting the instance', async () => {
    h.role = 'viewer'
    const res = await DELETE()
    expect(res.status).toBe(403)
    expect(h.deleteInstance).not.toHaveBeenCalled()
    expect(h.deletes).toHaveLength(0)
  })

  it('rejects unauthenticated callers', async () => {
    h.authed = false
    expect((await DELETE()).status).toBe(401)
    expect(h.deleteInstance).not.toHaveBeenCalled()
  })
})
