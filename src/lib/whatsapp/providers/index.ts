import { decrypt } from '@/lib/whatsapp/encryption'
import type { WhatsAppConfig } from '@/types'
import { createMetaProvider } from './meta'
import { createUazapiProvider } from './uazapi'
import type { ProviderFeature, ProviderId, WhatsAppProvider } from './types'

export type { ProviderFeature, ProviderId, WhatsAppProvider } from './types'

export class UnsupportedByProviderError extends Error {
  feature: ProviderFeature
  provider: ProviderId
  constructor(provider: ProviderId, feature: ProviderFeature) {
    super(`Feature "${feature}" is not supported by provider "${provider}"`)
    this.name = 'UnsupportedByProviderError'
    this.feature = feature
    this.provider = provider
  }
}

/** Static capability table; deliberately needs no credentials / decryption. */
const CAPABILITIES: Record<ProviderId, Record<ProviderFeature, boolean>> = {
  meta: { templates: true, interactive: true, broadcast: true, automations: true },
  uazapi: { templates: false, interactive: false, broadcast: false, automations: false },
}

export function assertSupports(
  config: Pick<WhatsAppConfig, 'provider'>,
  feature: ProviderFeature,
): void {
  if (!CAPABILITIES[config.provider][feature]) {
    throw new UnsupportedByProviderError(config.provider, feature)
  }
}

export function getProvider(config: WhatsAppConfig): WhatsAppProvider {
  if (config.provider === 'meta') {
    if (!config.phone_number_id) {
      throw new Error('Meta WhatsApp config is missing phone_number_id')
    }
    return createMetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
    })
  }
  if (config.provider === 'uazapi') {
    return createUazapiProvider(decrypt(config.access_token))
  }
  throw new Error(`Unknown WhatsApp provider "${config.provider}"`)
}
