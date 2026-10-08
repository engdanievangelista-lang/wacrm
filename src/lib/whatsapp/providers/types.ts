export type ProviderId = 'meta' | 'uazapi'
export type ProviderFeature = 'templates' | 'interactive' | 'broadcast' | 'automations'

export interface WhatsAppProvider {
  id: ProviderId
  supports: Record<ProviderFeature, boolean>
  sendText(a: { to: string; text: string; replyToMessageId?: string }): Promise<{ messageId: string }>
  sendMedia(a: {
    to: string
    kind: 'image' | 'video' | 'document' | 'audio'
    url: string
    caption?: string
    filename?: string
    replyToMessageId?: string
  }): Promise<{ messageId: string }>
  sendReaction(a: { to: string; messageId: string; emoji: string }): Promise<void>
}
