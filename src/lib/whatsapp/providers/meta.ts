import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api'
import type { WhatsAppProvider } from './types'

export interface MetaCredentials {
  phoneNumberId: string
  accessToken: string
}

/** Thin adapter over meta-api.ts: only maps argument names. */
export function createMetaProvider({
  phoneNumberId,
  accessToken,
}: MetaCredentials): WhatsAppProvider {
  return {
    id: 'meta',
    supports: { templates: true, interactive: true, broadcast: true, automations: true },
    async sendText(a) {
      const r = await sendTextMessage({
        phoneNumberId,
        accessToken,
        to: a.to,
        text: a.text,
        contextMessageId: a.replyToMessageId,
      })
      return { messageId: r.messageId }
    },
    async sendMedia(a) {
      const r = await sendMediaMessage({
        phoneNumberId,
        accessToken,
        to: a.to,
        kind: a.kind,
        link: a.url,
        caption: a.caption,
        filename: a.filename,
        contextMessageId: a.replyToMessageId,
      })
      return { messageId: r.messageId }
    },
    async sendReaction(a) {
      await sendReactionMessage({
        phoneNumberId,
        accessToken,
        to: a.to,
        targetMessageId: a.messageId,
        emoji: a.emoji,
      })
    },
  }
}
