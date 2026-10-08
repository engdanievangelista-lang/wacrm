import { timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { persistInboundMessage, type InboundContent } from '@/lib/whatsapp/inbound/persist'
import { applyMessageStatus } from '@/lib/whatsapp/inbound/status'
import {
  normalizeConnectionEvent,
  normalizeMessagesEvent,
  normalizeUpdateEvent,
  type UazapiMessage,
} from '@/lib/whatsapp/uazapi/normalize'

/**
 * Inbound webhook for UAZAPI instances.
 *
 * The URL carries a per-config random secret (`whatsapp_config.webhook_secret`)
 * that identifies the row; the envelope's `token` must then equal that row's
 * instance token. Both checks happen before anything is processed, and
 * neither value is ever logged or echoed.
 */

// The `after()` callback runs within this route's max duration; media
// mirroring can download a file per message, so give it headroom.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface UazapiConfigRow {
  id: string
  account_id: string
  user_id: string
  access_token: string
  mirror_inbound_media: boolean | null
}

/** Media download timeout. Well inside maxDuration. */
const MEDIA_FETCH_TIMEOUT_MS = 20_000

/** Constant-time string compare; unequal lengths are a mismatch, never a throw. */
function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0 || expected.length === 0) {
    return false
  }
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Burn a comparable amount of work so the length mismatch isn't an
    // obviously faster path, then report a mismatch.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

export async function POST(
  request: Request,
  context: { params: Promise<{ secret: string }> },
) {
  const { secret } = await context.params

  // Read the body up front so the request stream is consumed in every path.
  const rawBody = await request.text()

  if (!secret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: row, error: lookupError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, user_id, access_token, mirror_inbound_media')
    .eq('webhook_secret', secret)
    .eq('provider', 'uazapi')
    .maybeSingle()

  if (lookupError) {
    console.error('[uazapi-webhook] config lookup failed:', lookupError.message ?? 'unknown error')
  }
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const config = row as UazapiConfigRow

  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let instanceToken = ''
  try {
    instanceToken = config.access_token ? decrypt(config.access_token) : ''
  } catch {
    console.error(`[uazapi-webhook] could not decrypt instance token for config ${config.id}`)
  }
  if (!tokensMatch(body.token, instanceToken)) {
    console.warn(`[uazapi-webhook] rejected delivery with invalid token for config ${config.id}`)
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  // Ack immediately and process after the response. This MUST be `after()`
  // and not a detached promise: on serverless the function can be frozen
  // once the response is sent, silently dropping writes (issue #301 — see
  // the Meta webhook route).
  after(async () => {
    try {
      await processEvent(body, config)
    } catch (error) {
      console.error(
        `[uazapi-webhook] processing failed for config ${config.id}:`,
        error instanceof Error ? error.message : 'unknown error',
      )
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processEvent(body: Record<string, unknown>, config: UazapiConfigRow) {
  switch (body.EventType) {
    case 'messages': {
      const msg = normalizeMessagesEvent(body, {
        loadMedia: (m) => loadMedia(m, config),
      })
      if (!msg) return
      await persistInboundMessage(msg, {
        accountId: config.account_id,
        configOwnerUserId: config.user_id,
        dispatchAutomations: false,
      })
      return
    }
    case 'messages_update': {
      // Scoped to this config's account: the payload is not signed by the
      // platform, so a status event must never touch another tenant's rows.
      // Each id is isolated so one failure doesn't drop the rest.
      for (const update of normalizeUpdateEvent(body)) {
        try {
          await applyMessageStatus({ ...update, accountId: config.account_id })
        } catch (error) {
          console.error(
            `[uazapi-webhook] status update failed for message ${update.externalId}:`,
            error instanceof Error ? error.message : 'unknown error',
          )
        }
      }
      return
    }
    case 'connection': {
      const conn = normalizeConnectionEvent(body)
      if (!conn) return
      const status =
        conn.state === 'connected'
          ? 'connected'
          : conn.state === 'connecting'
            ? 'connecting'
            : 'disconnected'
      const { error } = await supabaseAdmin()
        .from('whatsapp_config')
        .update({ status })
        .eq('id', config.id)
      if (error) {
        console.error(
          `[uazapi-webhook] status update failed for config ${config.id}:`,
          error.message ?? 'unknown error',
        )
      }
      return
    }
    default:
      return
  }
}

const MEDIA_KINDS = ['image', 'video', 'audio', 'document', 'sticker'] as const

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** https only, and the host must resolve to public address space. */
async function isSafeMediaUrl(raw: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  return isDeliverableUrl(url.toString())
}

/**
 * Fetch a UAZAPI CDN file. Deliberately sends NO Authorization header —
 * `fileURL` is a public link, and the instance token must never leave for a
 * URL that arrived in a webhook payload. Redirects are not followed so a
 * vetted public URL cannot bounce to an internal one.
 */
async function downloadPublicFile(args: {
  downloadUrl: string
}): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(args.downloadUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`UAZAPI media download failed: ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`UAZAPI media too large: ${declared} bytes`)
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const buffer = await readCapped(response, MEDIA_MAX_BYTES)
  return { buffer, contentType }
}

/**
 * Read a response body, abandoning it as soon as it passes `cap` bytes.
 * The Content-Length pre-check alone is not enough: a chunked response
 * declares no length, and buffering it whole could spike serverless memory.
 */
async function readCapped(response: Response, cap: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      throw new Error(`UAZAPI media too large: over ${cap} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

/**
 * Content for a UAZAPI media message. Best effort: any failure (mirroring
 * disabled, unsafe URL, download/upload error) yields a text-only row with
 * `mediaUrl: null`, never a throw — the message itself must not be dropped.
 */
async function loadMedia(m: UazapiMessage, config: UazapiConfigRow): Promise<InboundContent> {
  const content = asRecord(m.content)
  const typeLower = (typeof m.messageType === 'string' ? m.messageType : '').toLowerCase()
  const kind = MEDIA_KINDS.find((k) => typeLower.includes(k)) ?? 'media'
  const caption = nonEmpty(content?.caption) ?? nonEmpty(m.text)
  const mimeType = nonEmpty(content?.mimetype) ?? nonEmpty(m.mimetype)

  let mediaUrl: string | null = null
  const fileURL = nonEmpty(m.fileURL)
  const mediaId = nonEmpty(m.messageid)

  if (config.mirror_inbound_media !== false && fileURL && mediaId) {
    try {
      if (await isSafeMediaUrl(fileURL)) {
        const tsMs = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : NaN
        mediaUrl = await mirrorInboundMedia({
          storage: supabaseAdmin().storage,
          accountId: config.account_id,
          mediaId,
          downloadUrl: fileURL,
          // Unused by the injected downloader; the instance token is never
          // handed to the mirror.
          accessToken: '',
          mimeType,
          fileName: nonEmpty(content?.fileName),
          messageTimestamp: Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : null,
          download: downloadPublicFile,
        })
      } else {
        console.warn(`[uazapi-webhook] refusing unsafe media URL for message ${mediaId}`)
      }
    } catch (error) {
      console.warn(
        `[uazapi-webhook] media mirror failed for message ${mediaId}:`,
        error instanceof Error ? error.message : 'unknown error',
      )
      mediaUrl = null
    }
  }

  return {
    contentText: caption ?? (mediaUrl ? null : `[${kind}]`),
    mediaUrl,
    mediaType: mimeType,
    interactiveReplyId: null,
  }
}
