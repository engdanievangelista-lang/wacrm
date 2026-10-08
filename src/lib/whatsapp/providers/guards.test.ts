import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Task 11: Meta-only features (templates, broadcast, interactive, automations)
// must fail with a CLEAR error on a non-Meta (UAZAPI) account instead of
// calling the Meta API with a UAZAPI token. Meta behaviour stays unchanged.
// ---------------------------------------------------------------------------

/** The account's whatsapp_config row, swapped per test. */
let configRow: Record<string, unknown> | null = null

const BASE_CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  phone_number_id: 'PNID-1',
  waba_id: 'WABA-1',
  access_token: 'enc-token',
}
const META_CONFIG = { ...BASE_CONFIG, provider: 'meta' }
const LEGACY_CONFIG = { ...BASE_CONFIG } // no provider field at all
const UAZAPI_CONFIG = { ...BASE_CONFIG, provider: 'uazapi', phone_number_id: null, waba_id: null }

const TEMPLATE = {
  id: '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
  name: 'order_update',
  status: 'APPROVED',
  meta_template_id: 'meta-1',
  language: 'en_US',
}

/** Every write the code under test attempted, by table. */
const writes: { table: string; op: string }[] = []

function makeDb() {
  function builder(table: string) {
    const result = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1', account_role: 'admin' }, error: null }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'whatsapp_config':
          return { data: configRow, error: configRow ? null : { message: 'none' } }
        case 'message_templates':
          return { data: TEMPLATE, error: null }
        case 'contacts':
          return {
            data: { id: 'c-1', phone: '5511999999999', wa_user_id: null },
            error: null,
          }
        case 'broadcasts':
          return { data: [{ id: 'bc-1', template_name: 't', template_language: 'en' }], error: null }
        case 'broadcast_recipients':
          return {
            data: [{ id: 'r-1', template_params: [], contact: { phone: '+5511999999999' } }],
            error: null,
          }
        default:
          return { data: null, error: null }
      }
    }
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit']) b[m] = vi.fn(() => b)
    for (const op of ['insert', 'update', 'delete', 'upsert']) {
      b[op] = vi.fn(() => {
        writes.push({ table, op })
        return b
      })
    }
    b.single = vi.fn(async () => result())
    b.maybeSingle = vi.fn(async () => result())
    b.then = (resolve: (v: unknown) => unknown) => resolve(result())
    return b
  }
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let db = makeDb()

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => db) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => db }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => db }))
vi.mock('@/lib/whatsapp/conversation-scope', () => ({
  assertConversationInAccount: vi.fn(async () => undefined),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { broadcast: {} },
}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: vi.fn(),
}))

const meta = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.1' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.2' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.3' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.4' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.5' })),
  editMessageTemplate: vi.fn(async () => ({})),
  deleteMessageTemplate: vi.fn(async () => ({})),
  submitMessageTemplate: vi.fn(async () => ({ id: 'm', status: 'PENDING' })),
  getMediaUrl: vi.fn(async () => ({ url: 'https://x', mimeType: 'image/png' })),
  downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'image/png' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)
vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureMediaHeaderHandle: vi.fn(async () => undefined),
}))

const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
vi.stubGlobal('fetch', fetchSpy)

import { UnsupportedByProviderError } from './index'
import { loadAccountMetaCredentials } from '@/lib/flows/meta-send'
import { engineSendText } from '@/lib/automations/meta-send'
import { POST as broadcastPOST } from '@/app/api/whatsapp/broadcast/route'
import { POST as resumePOST } from '@/app/api/whatsapp/broadcast/[id]/resume/route'
import { POST as submitPOST } from '@/app/api/whatsapp/templates/submit/route'
import { POST as syncPOST } from '@/app/api/whatsapp/templates/sync/route'
import { PATCH as templatePATCH, DELETE as templateDELETE } from '@/app/api/whatsapp/templates/[id]/route'
import { GET as mediaGET } from '@/app/api/whatsapp/media/[mediaId]/route'

function json(body: unknown) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function expectNoMetaCalls() {
  for (const fn of Object.values(meta)) expect(fn).not.toHaveBeenCalled()
  expect(fetchSpy).not.toHaveBeenCalled()
}

async function expectUnsupported(res: Response, feature: string) {
  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.code).toBe('unsupported_by_provider')
  expect(body.error).toContain(feature)
  expect(body.error).toContain('uazapi')
}

beforeEach(() => {
  writes.length = 0
  configRow = UAZAPI_CONFIG
  db = makeDb()
  for (const fn of Object.values(meta)) fn.mockClear()
  fetchSpy.mockClear()
})

describe('flows loadAccountMetaCredentials', () => {
  it('rejects with UnsupportedByProviderError for a UAZAPI account', async () => {
    await expect(loadAccountMetaCredentials(db as never, 'acct-1')).rejects.toBeInstanceOf(
      UnsupportedByProviderError,
    )
  })

  it('returns credentials for Meta and for a row with no provider field', async () => {
    for (const row of [META_CONFIG, LEGACY_CONFIG]) {
      configRow = row
      await expect(loadAccountMetaCredentials(db as never, 'acct-1')).resolves.toEqual({
        phoneNumberId: 'PNID-1',
        accessToken: 'plaintext-token',
      })
    }
  })
})

describe('automations sender', () => {
  const args = {
    accountId: 'acct-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    contactId: 'c-1',
    text: 'hi',
  }

  it('rejects with UnsupportedByProviderError for UAZAPI and never calls Meta', async () => {
    await expect(engineSendText(args)).rejects.toBeInstanceOf(UnsupportedByProviderError)
    expect(meta.sendTextMessage).not.toHaveBeenCalled()
  })

  it('still sends for Meta and for a row with no provider field', async () => {
    for (const row of [META_CONFIG, LEGACY_CONFIG]) {
      configRow = row
      meta.sendTextMessage.mockClear()
      await expect(engineSendText(args)).resolves.toEqual({ whatsapp_message_id: 'wamid.1' })
      expect(meta.sendTextMessage).toHaveBeenCalledTimes(1)
    }
  })
})

describe('routes on a UAZAPI account answer 400 unsupported_by_provider', () => {
  it('POST /broadcast', async () => {
    const res = await broadcastPOST(
      new Request('http://localhost/b', json({ recipients: [{ phone: '+5511999999999' }], template_name: 't' })),
    )
    await expectUnsupported(res, 'broadcast')
    expectNoMetaCalls()
    expect(writes).toHaveLength(0)
  })

  it('POST /broadcast/[id]/resume', async () => {
    const res = await resumePOST(new Request('http://localhost/r', json({})), {
      params: Promise.resolve({ id: 'bc-1' }),
    })
    await expectUnsupported(res, 'broadcast')
    expectNoMetaCalls()
  })

  it('POST /templates/submit', async () => {
    const res = await submitPOST(
      new Request(
        'http://localhost/s',
        json({ name: 'order_update', category: 'Utility', language: 'en_US', body_text: 'Hello' }),
      ),
    )
    await expectUnsupported(res, 'templates')
    expectNoMetaCalls()
    expect(writes).toHaveLength(0)
  })

  it('POST /templates/sync', async () => {
    const res = await syncPOST()
    await expectUnsupported(res, 'templates')
    expectNoMetaCalls()
    expect(writes).toHaveLength(0)
  })

  it('PATCH /templates/[id]', async () => {
    const res = await templatePATCH(
      new Request('http://localhost/t', {
        ...json({ name: 'order_update', category: 'Utility', language: 'en_US', body_text: 'Hello' }),
        method: 'PATCH',
      }),
      { params: Promise.resolve({ id: TEMPLATE.id }) },
    )
    await expectUnsupported(res, 'templates')
    expectNoMetaCalls()
  })

  it('DELETE /templates/[id]', async () => {
    const res = await templateDELETE(new Request('http://localhost/t'), {
      params: Promise.resolve({ id: TEMPLATE.id }),
    })
    await expectUnsupported(res, 'templates')
    expectNoMetaCalls()
    expect(writes.filter((w) => w.op === 'delete')).toHaveLength(0)
  })

  it('GET /media/[mediaId]', async () => {
    const res = await mediaGET(new Request('http://localhost/m'), {
      params: Promise.resolve({ mediaId: 'media-1' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('unsupported_by_provider')
    expect(body.error).toContain('uazapi')
    expectNoMetaCalls()
  })
})

describe('Meta accounts are unaffected by the guards', () => {
  it('media route still downloads for Meta and for a row with no provider', async () => {
    for (const row of [META_CONFIG, LEGACY_CONFIG]) {
      configRow = row
      meta.getMediaUrl.mockClear()
      const res = await mediaGET(new Request('http://localhost/m'), {
        params: Promise.resolve({ mediaId: 'media-1' }),
      })
      expect(res.status).toBe(200)
      expect(meta.getMediaUrl).toHaveBeenCalledTimes(1)
    }
  })

  it('templates sync passes the guard for Meta', async () => {
    configRow = META_CONFIG
    const res = await syncPOST()
    expect(res.status).not.toBe(400)
    expect(fetchSpy).toHaveBeenCalled()
  })
})
