import { NextResponse } from 'next/server'
import type { WhatsAppConfig } from '@/types'
import {
  assertSupports,
  UnsupportedByProviderError,
  type ProviderFeature,
} from './index'

/** Human-readable message naming both the feature and the provider. */
export function unsupportedByProviderMessage(err: UnsupportedByProviderError): string {
  return `The "${err.feature}" feature is not available for the "${err.provider}" WhatsApp provider. It requires the official Meta WhatsApp Cloud API.`
}

/** Standard 400 body for a Meta-only feature hit on a non-Meta account. */
export function unsupportedByProviderResponse(err: UnsupportedByProviderError): NextResponse {
  return NextResponse.json(
    { error: unsupportedByProviderMessage(err), code: 'unsupported_by_provider' },
    { status: 400 },
  )
}

/**
 * Route-level guard: returns the 400 response to send when the account's
 * provider does not support `feature`, or null when the route may proceed.
 * A config row without a `provider` is treated as Meta.
 */
export function providerGuardResponse(
  config: Pick<WhatsAppConfig, 'provider'>,
  feature: ProviderFeature,
): NextResponse | null {
  try {
    assertSupports(config, feature)
    return null
  } catch (err) {
    if (err instanceof UnsupportedByProviderError) {
      return unsupportedByProviderResponse(err)
    }
    throw err
  }
}
