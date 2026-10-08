import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { connectInstance } from '@/lib/whatsapp/uazapi/instance'
import {
  isInstanceGone,
  loadUazapiConfig,
  setConfigStatus,
  uazapiFailure,
} from '@/lib/whatsapp/uazapi/route-helpers'

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Starts (or restarts) the QR pairing flow for the caller account's UAZAPI
 * instance. Response: { qr, state }. `qr` may be null — UAZAPI's connect
 * response does not always carry it; the UI then takes the QR from
 * `GET /api/whatsapp/uazapi/status`, which is the authoritative source.
 */
export async function POST() {
  try {
    // Same gate as every other write to whatsapp_config (admin, settings-class).
    const { supabase, accountId } = await requireRole('admin')

    const loaded = await loadUazapiConfig(supabase, accountId, 'connect')
    if ('response' in loaded) return loaded.response
    const { row, token } = loaded

    let result: Awaited<ReturnType<typeof connectInstance>>
    try {
      result = await connectInstance(token)
    } catch (err) {
      if (isInstanceGone(err)) {
        if (row.status !== 'disconnected') {
          await setConfigStatus(supabase, accountId, { status: 'disconnected' }, 'connect')
        }
        return NextResponse.json(
          {
            error:
              'This WhatsApp instance no longer exists on the UAZAPI server. Remove the connection and create a new one.',
            state: 'disconnected',
          },
          { status: 409 },
        )
      }
      return uazapiFailure(err, 'connect')
    }

    if (result.state === 'connecting' && row.status === 'disconnected') {
      await setConfigStatus(supabase, accountId, { status: 'connecting' }, 'connect')
    }

    return NextResponse.json({ qr: result.qr ?? null, state: result.state })
  } catch (error) {
    console.error('Error in UAZAPI connect POST:', error instanceof Error ? error.name : 'unknown error')
    return toErrorResponse(error)
  }
}
