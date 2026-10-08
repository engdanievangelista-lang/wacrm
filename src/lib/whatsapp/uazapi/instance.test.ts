import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectInstance,
  configureWebhook,
  createInstance,
  deleteInstance,
  disconnectInstance,
  getInstanceStatus,
} from './instance'
import { UazapiError } from './client'

const fetchMock = vi.fn()

function reply(status: number, body?: unknown) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status })
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return {
    url: String(url),
    method: init.method as string,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  }
}

beforeEach(() => {
  process.env.UAZAPI_URL = 'https://uaz.example.com/'
  process.env.UAZAPI_ADMIN_TOKEN = 'admin-secret'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createInstance', () => {
  it('POSTs /instance/create with admintoken and maps token + instance.id', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { token: 'inst-tok', instance: { id: 'inst-1', status: 'disconnected' } }),
    )
    const r = await createInstance('my-inst')
    const c = lastCall()
    expect(c.url).toBe('https://uaz.example.com/instance/create')
    expect(c.method).toBe('POST')
    expect(c.headers.admintoken).toBe('admin-secret')
    expect(c.headers.token).toBeUndefined()
    expect(c.body).toEqual({ name: 'my-inst' })
    expect(r).toEqual({ instanceId: 'inst-1', token: 'inst-tok' })
  })
})

describe('configureWebhook', () => {
  it('POSTs /webhook in simple mode with the required payload', async () => {
    fetchMock.mockResolvedValue(reply(200, []))
    await configureWebhook('tok', 'https://app.example.com/api/webhook')
    const c = lastCall()
    expect(c.url).toBe('https://uaz.example.com/webhook')
    expect(c.method).toBe('POST')
    expect(c.headers.token).toBe('tok')
    expect(c.headers.admintoken).toBeUndefined()
    expect(c.body).toEqual({
      url: 'https://app.example.com/api/webhook',
      enabled: true,
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi', 'isGroupYes', 'fromMeYes'],
    })
    expect(c.body.action).toBeUndefined()
    expect(c.body.id).toBeUndefined()
  })
})

describe('connectInstance', () => {
  it('POSTs /instance/connect with no body and returns qr + state', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        connected: false,
        loggedIn: false,
        jid: null,
        instance: { id: 'i', status: 'connecting', qrcode: 'data:image/png;base64,AAA' },
      }),
    )
    const r = await connectInstance('tok')
    const c = lastCall()
    expect(c.url).toBe('https://uaz.example.com/instance/connect')
    expect(c.method).toBe('POST')
    expect(c.headers.token).toBe('tok')
    expect(c.body).toBeUndefined()
    expect(r).toEqual({ qr: 'data:image/png;base64,AAA', state: 'connecting' })
  })

  it('tolerates a missing qr / instance', async () => {
    fetchMock.mockResolvedValue(reply(200, { response: 'Connecting' }))
    const r = await connectInstance('tok')
    expect(r).toEqual({ qr: null, state: 'connecting' })
  })
})

describe('getInstanceStatus', () => {
  it('GETs /instance/status and maps the payload', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        instance: {
          id: 'i',
          status: 'connected',
          qrcode: '',
          profileName: 'Acme',
        },
        status: { connected: true, loggedIn: true, jid: { user: '5511999999999' } },
      }),
    )
    const r = await getInstanceStatus('tok')
    const c = lastCall()
    expect(c.url).toBe('https://uaz.example.com/instance/status')
    expect(c.method).toBe('GET')
    expect(c.headers.token).toBe('tok')
    expect(c.headers.admintoken).toBeUndefined()
    expect(r).toEqual({
      state: 'connected',
      qr: null,
      phone: '5511999999999',
      profileName: 'Acme',
    })
  })

  it('maps qr when connecting and null jid / profile', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        instance: { status: 'connecting', qrcode: 'data:image/png;base64,QQ' },
        status: { connected: false, loggedIn: false, jid: null },
      }),
    )
    expect(await getInstanceStatus('tok')).toEqual({
      state: 'connecting',
      qr: 'data:image/png;base64,QQ',
      phone: null,
      profileName: null,
    })
  })

  it('maps unknown status strings to disconnected', async () => {
    fetchMock.mockResolvedValue(reply(200, { instance: { status: 'weird' }, status: {} }))
    expect((await getInstanceStatus('tok')).state).toBe('disconnected')
  })

  it('accepts hibernated', async () => {
    fetchMock.mockResolvedValue(reply(200, { instance: { status: 'hibernated' }, status: {} }))
    expect((await getInstanceStatus('tok')).state).toBe('hibernated')
  })

  it.each([401, 404])('surfaces %i as UazapiError with status', async (status) => {
    fetchMock.mockResolvedValue(reply(status))
    const err = await getInstanceStatus('secret-tok').catch((e) => e)
    expect(err).toBeInstanceOf(UazapiError)
    expect(err.status).toBe(status)
    expect(err.message).not.toContain('secret-tok')
  })
})

describe('disconnectInstance', () => {
  it('POSTs /instance/disconnect with token', async () => {
    fetchMock.mockResolvedValue(reply(200, { response: 'Disconnected' }))
    await expect(disconnectInstance('tok')).resolves.toBeUndefined()
    const c = lastCall()
    expect(c.url).toBe('https://uaz.example.com/instance/disconnect')
    expect(c.method).toBe('POST')
    expect(c.headers.token).toBe('tok')
  })
})

describe('deleteInstance', () => {
  it('DELETEs /instance with token on 200', async () => {
    fetchMock.mockResolvedValue(reply(200, { response: 'deleted' }))
    await expect(deleteInstance('tok')).resolves.toBeUndefined()
    const c = lastCall()
    expect(c.url).toBe('https://uaz.example.com/instance')
    expect(c.method).toBe('DELETE')
    expect(c.headers.token).toBe('tok')
  })

  it('resolves on 202 (async deletion)', async () => {
    fetchMock.mockResolvedValue(reply(202))
    await expect(deleteInstance('tok')).resolves.toBeUndefined()
  })
})
