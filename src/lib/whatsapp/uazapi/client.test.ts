import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUazapiEnabled, uazapiEnv, uazapiRequest, UazapiError } from './client'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('UAZAPI_URL', 'https://free.uazapi.com/')
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('env', () => {
  it('uazapiEnv trims trailing slash and returns both', () => {
    expect(uazapiEnv()).toEqual({ baseUrl: 'https://free.uazapi.com', adminToken: 'admin-secret' })
    expect(isUazapiEnabled()).toBe(true)
  })
  it('null when either is missing', () => {
    vi.stubEnv('UAZAPI_ADMIN_TOKEN', '')
    expect(uazapiEnv()).toBeNull()
    expect(isUazapiEnabled()).toBe(false)
    vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'x')
    vi.stubEnv('UAZAPI_URL', '')
    expect(isUazapiEnabled()).toBe(false)
  })
})

describe('uazapiRequest', () => {
  it('sends token header, method, JSON body and returns json', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    const r = await uazapiRequest<{ ok: number }>({
      path: '/send/text',
      method: 'POST',
      token: 'inst-tok',
      body: { a: 1 },
    })
    expect(r).toEqual({ ok: 1 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://free.uazapi.com/send/text')
    expect(init.method).toBe('POST')
    expect(init.headers.token).toBe('inst-tok')
    expect(init.headers.admintoken).toBeUndefined()
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ a: 1 })
  })
  it('admin uses admintoken header', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await uazapiRequest({ path: '/instance/all', admin: true })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('GET')
    expect(init.headers.admintoken).toBe('admin-secret')
    expect(init.headers.token).toBeUndefined()
  })
  it('429 carries status and retryAfterSec, no tokens in message', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"slow down"}', { status: 429, headers: { 'Retry-After': '7' } }),
    )
    let err: unknown
    try {
      await uazapiRequest({
        path: '/send/text?x=querysecret',
        method: 'POST',
        token: 'inst-tok',
        body: { text: 'private' },
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UazapiError)
    const e = err as UazapiError
    expect(e.status).toBe(429)
    expect(e.retryAfterSec).toBe(7)
    expect(e.message).not.toContain('inst-tok')
    expect(e.message).not.toContain('admin-secret')
    expect(e.message).not.toContain('querysecret')
    expect(e.message).not.toContain('private')
  })
  it('throws when not configured', async () => {
    vi.stubEnv('UAZAPI_URL', '')
    await expect(uazapiRequest({ path: '/x' })).rejects.toBeInstanceOf(UazapiError)
  })
})
