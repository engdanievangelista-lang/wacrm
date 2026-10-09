import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { InboundMessage } from '@/lib/whatsapp/inbound/persist'

const SECRET = 'whsec-route-secret-abc123'
const INSTANCE_TOKEN = 'inst-token-0123456789abcdef'

const h = vi.hoisted(() => ({
  persistInboundMessage: vi.fn(),
  applyMessageStatus: vi.fn(),
  isDeliverableUrl: vi.fn(),
  state: {
    afterCallbacks: [] as (() => Promise<void> | void)[],
    /** Row the webhook_secret lookup resolves; null = unknown secret. */
    configRow: null as Record<string, unknown> | null,
    configEqs: [] as [string, unknown][],
    configUpdates: [] as { payload: Record<string, unknown>; eqs: [string, unknown][] }[],
    storageUploads: [] as { bucket: string; path: string; options: unknown }[],
    instanceToken: '',
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table ${table}`)
      return {
        select: () => {
          const chain = {
            eq(col: string, val: unknown) {
              h.state.configEqs.push([col, val])
              return chain
            },
            maybeSingle: () => {
              const eqs = Object.fromEntries(h.state.configEqs)
              const row = h.state.configRow
              const match =
                row && eqs.webhook_secret === row.webhook_secret && eqs.provider === 'uazapi'
              return Promise.resolve({ data: match ? row : null, error: null })
            },
          }
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          const rec = { payload, eqs: [] as [string, unknown][] }
          h.state.configUpdates.push(rec)
          const chain = {
            eq(col: string, val: unknown) {
              rec.eqs.push([col, val])
              return chain
            },
            then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
          }
          return chain
        },
      }
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, _body: unknown, options: unknown) => {
          h.state.storageUploads.push({ bucket, path, options })
          return Promise.resolve({ error: null })
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.example.test/${bucket}/${path}` },
        }),
      }),
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v !== 'enc-token') throw new Error('bad ciphertext')
    return h.state.instanceToken
  },
}))

vi.mock('@/lib/whatsapp/inbound/persist', () => ({
  persistInboundMessage: h.persistInboundMessage,
}))

vi.mock('@/lib/whatsapp/inbound/status', () => ({
  applyMessageStatus: h.applyMessageStatus,
}))

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: h.isDeliverableUrl,
}))

import { POST, maxDuration } from './route'

function baseRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    account_id: 'acc-1',
    user_id: 'user-1',
    access_token: 'enc-token',
    webhook_secret: SECRET,
    provider: 'uazapi',
    mirror_inbound_media: true,
    ...over,
  }
}

function req(body: unknown) {
  return new Request(`https://app.example.test/api/whatsapp/uazapi/webhook/${SECRET}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function ctx(secret = SECRET) {
  return { params: Promise.resolve({ secret }) }
}

type Res = { body: unknown; init?: { status?: number } }

async function call(body: unknown, secret = SECRET): Promise<Res> {
  const res = (await POST(req(body), ctx(secret))) as unknown as Res
  for (const cb of h.state.afterCallbacks.splice(0)) await cb()
  return res
}

function textEvent(over: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return {
    EventType: 'messages',
    token: INSTANCE_TOKEN,
    owner: '5511999999999',
    message: {
      id: '5511999999999:MSG_1',
      messageid: 'MSG_1',
      chatid: '5511888888888@s.whatsapp.net',
      sender: '5511888888888@s.whatsapp.net',
      senderName: 'Cliente',
      fromMe: false,
      isGroup: false,
      messageType: 'Conversation',
      text: 'Olá',
      messageTimestamp: 1788868800000,
      ...over,
    },
    ...envelope,
  }
}

function imageEvent(over: Record<string, unknown> = {}) {
  return textEvent({
    messageType: 'ImageMessage',
    text: 'legenda',
    fileURL: 'https://files.uazapi.example/abc.jpg',
    content: { mimetype: 'image/jpeg', caption: 'legenda' },
    ...over,
  })
}

let logs: string[]
const fetchMock = vi.fn()

beforeEach(() => {
  h.persistInboundMessage.mockReset().mockResolvedValue(undefined)
  h.applyMessageStatus.mockReset().mockResolvedValue(undefined)
  h.isDeliverableUrl.mockReset().mockResolvedValue(true)
  h.state.afterCallbacks = []
  h.state.configRow = baseRow()
  h.state.configEqs = []
  h.state.configUpdates = []
  h.state.storageUploads = []
  h.state.instanceToken = INSTANCE_TOKEN
  fetchMock.mockReset().mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  logs = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function persistedMessage(): InboundMessage {
  expect(h.persistInboundMessage).toHaveBeenCalledTimes(1)
  return h.persistInboundMessage.mock.calls[0][0] as InboundMessage
}

describe('UAZAPI webhook route', () => {
  it('exports maxDuration = 60', () => {
    expect(maxDuration).toBe(60)
  })

  it('looks the row up by webhook_secret AND provider = uazapi', async () => {
    await call(textEvent())
    expect(h.state.configEqs).toEqual(
      expect.arrayContaining([
        ['webhook_secret', SECRET],
        ['provider', 'uazapi'],
      ]),
    )
  })

  it('unknown secret → 404 and nothing processed', async () => {
    const res = await call(textEvent(), 'nope')
    expect(res.init?.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found' })
    expect(h.state.afterCallbacks).toEqual([])
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
    expect(h.applyMessageStatus).not.toHaveBeenCalled()
  })

  it('wrong envelope token → 401 and nothing processed', async () => {
    const res = await call(textEvent({}, { token: 'inst-token-0123456789abcdeX' }))
    expect(res.init?.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid token' })
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
  })

  it('missing token → 401', async () => {
    const body = textEvent()
    delete (body as { token?: string }).token
    const res = await call(body)
    expect(res.init?.status).toBe(401)
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
  })

  it('non-string token → 401', async () => {
    const res = await call(textEvent({}, { token: 12345 }))
    expect(res.init?.status).toBe(401)
  })

  it('token of a different length → 401 without throwing', async () => {
    const res = await call(textEvent({}, { token: 'short' }))
    expect(res.init?.status).toBe(401)
    const res2 = await call(textEvent({}, { token: INSTANCE_TOKEN + 'extra-long-suffix' }))
    expect(res2.init?.status).toBe(401)
  })

  it('undecryptable stored token → 401, nothing processed', async () => {
    h.state.configRow = baseRow({ access_token: 'garbage' })
    const res = await call(textEvent())
    expect(res.init?.status).toBe(401)
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
  })

  it('invalid JSON → 400', async () => {
    const res = await call('{not json')
    expect(res.init?.status).toBe(400)
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
  })

  it('valid messages event → 200 and persist called with the normalised message', async () => {
    const res = await call(textEvent())
    expect(res.init?.status).toBe(200)
    expect(res.body).toEqual({ status: 'received' })
    const msg = persistedMessage()
    expect(h.persistInboundMessage.mock.calls[0][1]).toEqual({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      dispatchAutomations: false,
    })
    expect(msg.externalId).toBe('MSG_1')
    expect(msg.identity.phone).toBe('5511888888888')
    expect(msg.rawType).toBe('text')
    expect(await msg.loadContent()).toEqual({
      contentText: 'Olá',
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    })
  })

  it('processing happens inside after(), not before the response', async () => {
    const res = (await POST(req(textEvent()), ctx())) as unknown as Res
    expect(res.init?.status).toBe(200)
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
    expect(h.state.afterCallbacks).toHaveLength(1)
    await h.state.afterCallbacks.splice(0)[0]()
    expect(h.persistInboundMessage).toHaveBeenCalledTimes(1)
  })

  it('same event delivered twice → persist called twice (idempotency lives in persist)', async () => {
    await call(textEvent())
    await call(textEvent())
    expect(h.persistInboundMessage).toHaveBeenCalledTimes(2)
    expect(h.persistInboundMessage.mock.calls[0][0].externalId).toBe(
      h.persistInboundMessage.mock.calls[1][0].externalId,
    )
  })

  it('ignored event (fromMe) → 200, persist not called', async () => {
    const res = await call(textEvent({ fromMe: true }))
    expect(res.init?.status).toBe(200)
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
  })

  it('a processing failure is caught and logged', async () => {
    h.persistInboundMessage.mockRejectedValueOnce(new Error('db down'))
    const res = await call(textEvent())
    expect(res.init?.status).toBe(200)
    expect(logs.some((l) => l.includes('db down'))).toBe(true)
  })

  it('messages_update ReadReceipt Read → applyMessageStatus per id', async () => {
    const res = await call({
      EventType: 'messages_update',
      token: INSTANCE_TOKEN,
      type: 'ReadReceipt',
      state: 'Read',
      event: { MessageIDs: ['MSG_A', 'MSG_B'], Timestamp: 1788868800 },
    })
    expect(res.init?.status).toBe(200)
    expect(h.applyMessageStatus).toHaveBeenCalledTimes(2)
    expect(h.applyMessageStatus).toHaveBeenNthCalledWith(1, {
      externalId: 'MSG_A',
      status: 'read',
      timestampSec: 1788868800,
      accountId: 'acc-1',
    })
    expect(h.applyMessageStatus.mock.calls[1][0]).toMatchObject({
      externalId: 'MSG_B',
      status: 'read',
      accountId: 'acc-1',
    })
  })

  it('messages_update: one failing status does not abort the rest of the batch', async () => {
    h.applyMessageStatus.mockRejectedValueOnce(new Error('db down'))
    const res = await call({
      EventType: 'messages_update',
      token: INSTANCE_TOKEN,
      type: 'ReadReceipt',
      state: 'Delivered',
      event: { MessageIDs: ['MSG_A', 'MSG_B', 'MSG_C'], Timestamp: 1788868800 },
    })
    expect(res.init?.status).toBe(200)
    expect(h.applyMessageStatus).toHaveBeenCalledTimes(3)
    expect(h.applyMessageStatus.mock.calls.map((c) => c[0].externalId)).toEqual([
      'MSG_A',
      'MSG_B',
      'MSG_C',
    ])
    expect(logs.some((l) => l.includes('db down'))).toBe(true)
  })

  it.each([
    ['disconnected', 'disconnected'],
    ['hibernated', 'disconnected'],
    ['connected', 'connected'],
    ['connecting', 'connecting'],
  ])('connection %s → config status %s on that row', async (incoming, stored) => {
    const res = await call({
      EventType: 'connection',
      token: INSTANCE_TOKEN,
      instance: { status: incoming },
    })
    expect(res.init?.status).toBe(200)
    expect(h.state.configUpdates).toHaveLength(1)
    expect(h.state.configUpdates[0].payload).toEqual({ status: stored })
    expect(h.state.configUpdates[0].eqs).toEqual([['id', 'cfg-1']])
  })

  it('connection event without a status updates nothing', async () => {
    await call({ EventType: 'connection', token: INSTANCE_TOKEN, instance: {} })
    expect(h.state.configUpdates).toEqual([])
  })

  it('unknown EventType → 200, nothing called', async () => {
    const res = await call({ EventType: 'presence', token: INSTANCE_TOKEN })
    expect(res.init?.status).toBe(200)
    expect(h.persistInboundMessage).not.toHaveBeenCalled()
    expect(h.applyMessageStatus).not.toHaveBeenCalled()
    expect(h.state.configUpdates).toEqual([])
  })

  it('never echoes or logs the token or the secret', async () => {
    const results: Res[] = []
    results.push(await call(textEvent(), 'wrong-secret'))
    results.push(await call(textEvent({}, { token: 'wrong-token-same-length-xx' })))
    results.push(await call(textEvent({}, { token: 'short' })))
    results.push(await call('{bad json'))
    h.persistInboundMessage.mockRejectedValueOnce(new Error('boom'))
    results.push(await call(textEvent()))
    h.state.configRow = baseRow({ access_token: 'garbage' })
    results.push(await call(textEvent()))
    const haystack = JSON.stringify(results) + '\n' + logs.join('\n')
    for (const needle of [SECRET, INSTANCE_TOKEN, 'wrong-token-same-length-xx', 'wrong-secret']) {
      expect(haystack).not.toContain(needle)
    }
  })
})

describe('UAZAPI webhook loadMedia', () => {
  it('mirrors fileURL into storage, fetching WITHOUT an Authorization header', async () => {
    await call(imageEvent())
    const msg = persistedMessage()
    expect(msg.rawType).toBe('image')
    const content = await msg.loadContent()

    expect(h.isDeliverableUrl).toHaveBeenCalledWith('https://files.uazapi.example/abc.jpg')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toBe('https://files.uazapi.example/abc.jpg')
    const headers = new Headers(init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(JSON.stringify(init ?? {})).not.toContain(INSTANCE_TOKEN)
    expect(init?.redirect).toBe('manual')

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    expect(h.state.storageUploads[0].path).toContain('MSG_1')
    expect(content).toEqual({
      contentText: 'legenda',
      mediaUrl: expect.stringContaining('https://cdn.example.test/chat-media/'),
      mediaType: 'image/jpeg',
      interactiveReplyId: null,
    })
  })

  it('SSRF-rejected URL → text fallback, mediaUrl null, no fetch', async () => {
    h.isDeliverableUrl.mockResolvedValue(false)
    await call(imageEvent({ text: '', content: { mimetype: 'image/jpeg' } }))
    const content = await persistedMessage().loadContent()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(content).toEqual({
      contentText: '[image]',
      mediaUrl: null,
      mediaType: 'image/jpeg',
      interactiveReplyId: null,
    })
  })

  it('non-https fileURL is rejected without consulting DNS or fetching', async () => {
    await call(imageEvent({ fileURL: 'http://files.uazapi.example/abc.jpg' }))
    const content = await persistedMessage().loadContent()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(content.mediaUrl).toBeNull()
    expect(content.contentText).toBe('legenda')
  })

  it('malformed fileURL falls back without throwing', async () => {
    await call(imageEvent({ fileURL: 'not a url' }))
    const content = await persistedMessage().loadContent()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(content.mediaUrl).toBeNull()
  })

  it('mirroring disabled → no fetch, text fallback', async () => {
    h.state.configRow = baseRow({ mirror_inbound_media: false })
    await call(imageEvent())
    const content = await persistedMessage().loadContent()
    expect(h.isDeliverableUrl).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(content).toMatchObject({ contentText: 'legenda', mediaUrl: null })
  })

  it('no fileURL → no fetch, text fallback', async () => {
    await call(imageEvent({ fileURL: undefined }))
    const content = await persistedMessage().loadContent()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(content.mediaUrl).toBeNull()
  })

  it('download failure → falls back, message still persisted', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    await call(imageEvent({ text: '', content: { mimetype: 'audio/ogg' }, messageType: 'AudioMessage' }))
    const content = await persistedMessage().loadContent()
    expect(content).toEqual({
      contentText: '[audio]',
      mediaUrl: null,
      mediaType: 'audio/ogg',
      interactiveReplyId: null,
    })
  })

  it('streamed body over the cap with no content-length is abandoned mid-stream', async () => {
    const CHUNK = 1024 * 1024
    const TOTAL_CHUNKS = 40 // 40 MB offered, cap is 16 MB
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= TOTAL_CHUNKS) {
          controller.close()
          return
        }
        pulled++
        controller.enqueue(new Uint8Array(CHUNK))
      },
      cancel() {
        cancelled = true
      },
    })
    fetchMock.mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    )
    await call(imageEvent())
    const content = await persistedMessage().loadContent()
    expect(content.mediaUrl).toBeNull()
    expect(content.contentText).toBe('legenda')
    expect(h.state.storageUploads).toEqual([])
    expect(cancelled).toBe(true)
    // Stopped just past the 16 MB cap, far short of the 40 MB offered.
    expect(pulled).toBeLessThan(20)
  })

  it('declared content-length over the cap is refused before reading', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(10))
        controller.close()
      },
    })
    fetchMock.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(50 * 1024 * 1024) },
      }),
    )
    await call(imageEvent())
    const content = await persistedMessage().loadContent()
    expect(content.mediaUrl).toBeNull()
    expect(h.state.storageUploads).toEqual([])
    expect(pulled).toBeLessThanOrEqual(1)
  })

  it('a redirect response is not followed and falls back', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    )
    await call(imageEvent())
    const content = await persistedMessage().loadContent()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(content.mediaUrl).toBeNull()
  })

  it('fetch throwing → falls back without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    await call(imageEvent())
    await expect(persistedMessage().loadContent()).resolves.toMatchObject({ mediaUrl: null })
  })
})
