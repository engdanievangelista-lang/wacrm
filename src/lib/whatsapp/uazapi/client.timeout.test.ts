import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uazapiRequest, UazapiError } from './client'
import { uazapiFailure, isInstanceGone } from './route-helpers'

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'x') }))

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('UAZAPI_URL', 'https://free.uazapi.com')
  vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'admin-secret')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function catchErr(): Promise<UazapiError> {
  try {
    await uazapiRequest({
      path: '/send/text?x=querysecret',
      method: 'POST',
      token: 'inst-tok',
      body: { text: 'private' },
    })
  } catch (e) {
    return e as UazapiError
  }
  throw new Error('expected rejection')
}

function expectClean(e: UazapiError) {
  for (const s of ['inst-tok', 'admin-secret', 'querysecret', 'private', '?']) {
    expect(e.message).not.toContain(s)
  }
}

describe('uazapiRequest timeout / network failure', () => {
  it('passes an AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await uazapiRequest({ path: '/x' })
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('converts a rejected fetch (TypeError) to UazapiError 502', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: inst-tok'))
    const e = await catchErr()
    expect(e).toBeInstanceOf(UazapiError)
    expect(e.status).toBe(502)
    expect(e.message).toContain('/send/text')
    expectClean(e)
  })

  it.each(['TimeoutError', 'AbortError'])('converts %s to UazapiError 504', async (name) => {
    fetchMock.mockRejectedValue(new DOMException('aborted', name))
    const e = await catchErr()
    expect(e).toBeInstanceOf(UazapiError)
    expect(e.status).toBe(504)
    expect(e.message).toContain('timed out')
    expectClean(e)
  })

  it('504/502 map to the generic 502 branch, not instance-gone or 429', () => {
    for (const status of [504, 502]) {
      const err = new UazapiError('x', status)
      expect(isInstanceGone(err)).toBe(false)
      const res = uazapiFailure(err, 'test')
      expect(res.status).toBe(502)
      expect(res.headers.get('Retry-After')).toBeNull()
    }
  })
})
