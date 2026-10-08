import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi/instance'
import {
  isInstanceGone,
  loadUazapiConfig,
  setConfigStatus,
  uazapiFailure,
} from '@/lib/whatsapp/uazapi/route-helpers'

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Polled by the settings UI while a QR is shown. Proxies UAZAPI
 * `/instance/status` for the caller's own account and mirrors the result
 * into `whatsapp_config`. This is the authoritative QR source — the connect
 * route's QR is best effort.
 *
 * Response: { state, qr, phone, profileName } — never any token or secret.
 */
export async function GET() {
  try {
    // Admin, like every other write to whatsapp_config (RLS: settings-class).
    // The QR pairs a phone to this account, so it is not shown to lower roles.
    const { supabase, accountId } = await requireRole('admin')

    const loaded = await loadUazapiConfig(supabase, accountId, 'status')
    if ('response' in loaded) return loaded.response
    const { row, token } = loaded

    let result: Awaited<ReturnType<typeof getInstanceStatus>>
    try {
      result = await getInstanceStatus(token)
    } catch (err) {
      if (isInstanceGone(err)) {
        // The instance was deleted on the UAZAPI side; it cannot recover.
        if (row.status !== 'disconnected') {
          await setConfigStatus(supabase, accountId, { status: 'disconnected' }, 'status')
        }
        return NextResponse.json({ state: 'disconnected', qr: null, phone: null, profileName: null })
      }
      return uazapiFailure(err, 'status')
    }

    const { state, qr, phone, profileName } = result
    if (state === 'connected') {
      const current = row.provider_config ?? {}
      const changed =
        row.status !== 'connected' ||
        (current.phone ?? null) !== phone ||
        (current.profile_name ?? null) !== profileName
      if (changed) {
        await setConfigStatus(
          supabase,
          accountId,
          {
            status: 'connected',
            ...(row.status !== 'connected' ? { connected_at: new Date().toISOString() } : {}),
            provider_config: { ...current, phone, profile_name: profileName },
          },
          'status',
        )
      }
    } else if (state === 'connecting') {
      if (row.status !== 'connecting') {
        await setConfigStatus(supabase, accountId, { status: 'connecting' }, 'status')
      }
    } else if (row.status !== 'disconnected') {
      // 'disconnected' or 'hibernated': nothing can be sent until re-paired.
      await setConfigStatus(supabase, accountId, { status: 'disconnected' }, 'status')
    }

    return NextResponse.json({ state, qr, phone, profileName })
  } catch (error) {
    console.error('Error in UAZAPI status GET:', error instanceof Error ? error.name : 'unknown error')
    return toErrorResponse(error)
  }
}
