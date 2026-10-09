import { UazapiError, uazapiRequest } from '@/lib/whatsapp/uazapi/client'
import type { WhatsAppProvider } from './types'

function requirePhone(to: string): string {
  if (!/^\d+$/.test(to)) {
    throw new UazapiError('UAZAPI needs a phone number (digits only) to send a message', 400)
  }
  return to
}

/** Short WhatsApp id: `messageid`, else the part of `id` after the last ':'. */
function extractMessageId(res: unknown): string {
  const r = (res ?? {}) as { messageid?: unknown; id?: unknown }
  if (typeof r.messageid === 'string' && r.messageid) return r.messageid
  if (typeof r.id === 'string' && r.id) {
    const short = r.id.slice(r.id.lastIndexOf(':') + 1)
    if (short) return short
  }
  throw new UazapiError('UAZAPI send response did not include a message id', 502)
}

export function createUazapiProvider(token: string): WhatsAppProvider {
  return {
    id: 'uazapi',
    supports: { templates: false, interactive: false, broadcast: false, automations: false },
    async sendText(a) {
      const number = requirePhone(a.to)
      const res = await uazapiRequest<unknown>({
        path: '/send/text',
        method: 'POST',
        token,
        body: { number, text: a.text, replyid: a.replyToMessageId },
      })
      return { messageId: extractMessageId(res) }
    },
    async sendMedia(a) {
      const number = requirePhone(a.to)
      const res = await uazapiRequest<unknown>({
        path: '/send/media',
        method: 'POST',
        token,
        body: {
          number,
          type: a.kind,
          file: a.url,
          text: a.caption,
          docName: a.filename,
          replyid: a.replyToMessageId,
        },
      })
      return { messageId: extractMessageId(res) }
    },
    async sendReaction(a) {
      requirePhone(a.to)
      await uazapiRequest<unknown>({
        path: '/message/react',
        method: 'POST',
        token,
        body: { id: a.messageId, text: a.emoji },
      })
    },
  }
}
