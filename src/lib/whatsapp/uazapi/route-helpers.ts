import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { UazapiError } from './client'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Shared pieces of the UAZAPI settings routes (`/api/whatsapp/config`,
 * `/api/whatsapp/uazapi/connect`, `/api/whatsapp/uazapi/status`).
 *
 * Nothing here ever puts the instance token, the admin token or the webhook
 * secret into a response body or a log line.
 */

/** Seconds suggested to the browser when UAZAPI throttles without a Retry-After. */
const DEFAULT_RETRY_AFTER_SEC = 5

/**
 * A 401/404 from an instance-token endpoint means the instance no longer
 * exists (free UAZAPI servers delete instances after an hour) or its token
 * was revoked — either way it can never come back, so the row is stale.
 */
export function isInstanceGone(err: unknown): boolean {
  return err instanceof UazapiError && (err.status === 401 || err.status === 404)
}

/**
 * Turn a failed UAZAPI call into a response. A 429 keeps its Retry-After;
 * anything else — a vendor error or a rejected `fetch` (plain TypeError) — is
 * a generic 502 whose details stay in the server log.
 */
export function uazapiFailure(err: unknown, step: string): NextResponse {
  if (err instanceof UazapiError && err.status === 429) {
    const retryAfter = err.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC
    console.warn(`[uazapi/${step}] rate limited by UAZAPI (retry after ${retryAfter}s)`)
    return NextResponse.json(
      {
        error: 'The WhatsApp server is receiving too many requests. Please wait a moment and try again.',
        retry_after_seconds: retryAfter,
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    )
  }
  if (err instanceof UazapiError) {
    // UazapiError messages carry only the method, path and status.
    console.error(`[uazapi/${step}] ${err.message}`)
  } else {
    console.error(
      `[uazapi/${step}] request failed:`,
      err instanceof Error ? err.name : 'unknown error',
    )
  }
  return NextResponse.json(
    { error: 'Could not reach the WhatsApp (UAZAPI) server. Please try again in a moment.' },
    { status: 502 },
  )
}

export interface UazapiConfigRow {
  id: string
  provider: string | null
  status: string | null
  access_token: string
  provider_config: { instance_id?: string; phone?: string | null; profile_name?: string | null } | null
}

/**
 * Load the caller account's UAZAPI row and decrypt its instance token.
 * Resolves to a ready-to-return response when there is nothing to act on.
 */
export async function loadUazapiConfig(
  supabase: SupabaseClient,
  accountId: string,
  step: string,
): Promise<{ row: UazapiConfigRow; token: string } | { response: NextResponse }> {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('id, provider, status, access_token, provider_config')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) {
    console.error(`[uazapi/${step}] config lookup failed:`, error.message ?? 'unknown error')
    return {
      response: NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 }),
    }
  }
  const row = data as UazapiConfigRow | null
  if (!row || row.provider !== 'uazapi') {
    return {
      response: NextResponse.json(
        { error: 'No UAZAPI WhatsApp connection is configured for this account.' },
        { status: 400 },
      ),
    }
  }

  try {
    return { row, token: decrypt(row.access_token) }
  } catch {
    console.error(`[uazapi/${step}] could not decrypt instance token for config ${row.id}`)
    return {
      response: NextResponse.json(
        {
          error:
            'The stored UAZAPI credentials cannot be decrypted with the current ENCRYPTION_KEY. Remove the connection and create it again.',
        },
        { status: 500 },
      ),
    }
  }
}

/** Set the row's status, logging (never throwing) on a DB error. */
export async function setConfigStatus(
  supabase: SupabaseClient,
  accountId: string,
  patch: Record<string, unknown>,
  step: string,
): Promise<void> {
  const { error } = await supabase
    .from('whatsapp_config')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
  if (error) {
    console.error(`[uazapi/${step}] status update failed:`, error.message ?? 'unknown error')
  }
}
