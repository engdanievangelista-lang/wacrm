import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UazapiError } from '../uazapi/client'
import { createUazapiProvider } from './uazapi'

const fetchMock = vi.fn()
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })

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

describe('uazapi provider', () => {
  it('has id and all-false supports', () => {
    const p = createUazapiProvider('tok')
    expect(p.id).toBe('uazapi')
    expect(p.supports).toEqual({
      templates: false,
      interactive: false,
      broadcast: false,
      automations: false,
    })
  })

  it('sendText posts body and uses messageid', async () => {
    fetchMock.mockResolvedValue(ok({ id: '5511999999999:ABC', messageid: 'ABC' }))
    const r = await createUazapiProvider('tok').sendText({
      to: '5511999999999',
      text: 'hi',
      replyToMessageId: 'R1',
    })
    expect(r).toEqual({ messageId: 'ABC' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://free.uazapi.com/send/text')
    expect(init.method).toBe('POST')
    expect(init.headers.token).toBe('tok')
    expect(JSON.parse(init.body)).toEqual({ number: '5511999999999', text: 'hi', replyid: 'R1' })
  })

  it('derives id from id after last colon when messageid missing', async () => {
    fetchMock.mockResolvedValue(ok({ id: '5511999999999:ABC' }))
    const r = await createUazapiProvider('tok').sendText({ to: '5511999999999', text: 'hi' })
    expect(r.messageId).toBe('ABC')
  })

  it('throws when no id derivable', async () => {
    fetchMock.mockResolvedValue(ok({ foo: 1 }))
    await expect(
      createUazapiProvider('tok').sendText({ to: '5511999999999', text: 'hi' }),
    ).rejects.toThrow(/message id/i)
  })

  it('sendMedia posts media body', async () => {
    fetchMock.mockResolvedValue(ok({ id: '5511999999999:XYZ' }))
    const r = await createUazapiProvider('tok').sendMedia({
      to: '5511999999999',
      kind: 'document',
      url: 'https://x/f.pdf',
      caption: 'cap',
      filename: 'f.pdf',
      replyToMessageId: 'R2',
    })
    expect(r.messageId).toBe('XYZ')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://free.uazapi.com/send/media')
    expect(JSON.parse(init.body)).toEqual({
      number: '5511999999999',
      type: 'document',
      file: 'https://x/f.pdf',
      text: 'cap',
      docName: 'f.pdf',
      replyid: 'R2',
    })
  })

  it('sendReaction posts id and text', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }))
    await createUazapiProvider('tok').sendReaction({
      to: '5511999999999',
      messageId: 'M1',
      emoji: '\u{1F44D}',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://free.uazapi.com/message/react')
    expect(JSON.parse(init.body)).toEqual({ id: 'M1', text: '\u{1F44D}' })
  })

  it('rejects non-numeric to without calling fetch', async () => {
    const p = createUazapiProvider('tok')
    for (const call of [
      () => p.sendText({ to: 'bsuid.abc', text: 'x' }),
      () => p.sendMedia({ to: '+5511', kind: 'image', url: 'u' }),
      () => p.sendReaction({ to: 'abc', messageId: 'm', emoji: 'x' }),
    ]) {
      const err = await call().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UazapiError)
      expect((err as Error).message).toMatch(/phone number/i)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('error message contains no token', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const err = await createUazapiProvider('super-tok')
      .sendText({ to: '5511999999999', text: 'hi' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UazapiError)
    expect((err as Error).message).not.toContain('super-tok')
    expect((err as UazapiError).status).toBe(500)
  })
})
