import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  getSubscribedApps,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import {
  explainMetaError,
  metaErrorPayload,
  type MetaConnectStep,
  type MetaErrorContext,
} from '@/lib/whatsapp/meta-error-explain'
import {
  appSubscriptionState,
  describeWabaPhoneMismatch,
  isNumericMetaId,
  phoneNumberBelongsToWaba,
} from '@/lib/whatsapp/waba-pairing'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { resolveVerifyTokenForSave } from '@/lib/whatsapp/verify-token'
import { randomBytes } from 'node:crypto'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isUazapiEnabled, UazapiError } from '@/lib/whatsapp/uazapi/client'
import { configureWebhook, createInstance, deleteInstance } from '@/lib/whatsapp/uazapi/instance'
import { uazapiFailure } from '@/lib/whatsapp/uazapi/route-helpers'

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Shape every failed Meta call into `{ error, meta }` — the actionable
 * text plus the code / subcode / fbtrace_id / step a user can quote to
 * Meta support. Status is 400 when the fix is on the user's side (token,
 * ids, PIN) and 502 when Meta has to change something (issue #505).
 */
function metaFailure(err: unknown, step: MetaConnectStep, ctx: MetaErrorContext) {
  const explained = explainMetaError(err, step, ctx)
  console.error(`[whatsapp/config] Meta ${step} failed:`, explained.metaMessage, {
    code: explained.code,
    subcode: explained.subcode,
    fbtrace_id: explained.fbtraceId,
  })
  return NextResponse.json(
    { error: explained.summary, meta: metaErrorPayload(explained) },
    { status: explained.httpStatus },
  )
}

type ProviderId = 'meta' | 'uazapi'

/** Providers this deployment can offer. UAZAPI only when its env is set. */
function listAvailableProviders(): ProviderId[] {
  return isUazapiEnabled() ? ['meta', 'uazapi'] : ['meta']
}

/**
 * Public base URL UAZAPI should call back. Same resolution order as the
 * invite links (src/app/api/account/invitations/route.ts): explicit
 * `NEXT_PUBLIC_SITE_URL`, then the proxy's X-Forwarded-Host/-Proto, then
 * the Host header with the request's protocol — each request-derived host
 * checked against `ALLOWED_INVITE_HOSTS` when that list is set. Unlike
 * invites there is no marketing-site fallback: a webhook pointed anywhere
 * else would silently drop every message, so null is returned instead.
 */
function publicBaseUrl(request: Request): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const allowRaw = process.env.ALLOWED_INVITE_HOSTS?.trim()
  const allowList = allowRaw
    ? allowRaw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    : []
  const allowed = (host: string) =>
    allowList.length === 0 || allowList.includes(host.toLowerCase())

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost && allowed(forwardedHost)) {
    return `${forwardedProto || 'https'}://${forwardedHost}`
  }

  const host = request.headers.get('host')?.trim()
  if (host && allowed(host)) {
    const proto = new URL(request.url).protocol.replace(':', '')
    return `${proto}://${host}`
  }
  return null
}

/** Best-effort UAZAPI instance removal. Never throws; never logs the token. */
async function deleteInstanceQuietly(token: string, step: string): Promise<void> {
  try {
    await deleteInstance(token)
  } catch (err) {
    console.warn(
      `[whatsapp/config] UAZAPI instance delete failed (${step}):`,
      err instanceof UazapiError ? err.message : err instanceof Error ? err.name : 'unknown error',
    )
  }
}

async function deleteUazapiInstanceQuietly(encryptedToken: string, step: string): Promise<void> {
  let token: string
  try {
    token = decrypt(encryptedToken)
  } catch {
    console.warn(`[whatsapp/config] could not decrypt UAZAPI instance token (${step}); skipping remote delete`)
    return
  }
  await deleteInstanceQuietly(token, step)
}

/**
 * POST /api/whatsapp/config with `{ provider: 'uazapi' }`.
 *
 * Creates a UAZAPI instance for the caller's account, points its webhook at
 * `/api/whatsapp/uazapi/webhook/<secret>` and stores the row as
 * 'connecting'. The QR is fetched afterwards via the uazapi connect/status
 * routes. Answers `{ success, provider, status }` — never a token or secret.
 */
async function createUazapiConfig(request: Request): Promise<NextResponse> {
  // whatsapp_config writes are admin-only under RLS; the vendor calls below
  // happen before any write, so the gate must be explicit here.
  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId, userId } = ctx

  if (!isUazapiEnabled()) {
    return NextResponse.json(
      {
        error:
          'UAZAPI is not enabled on this server. Set UAZAPI_URL and UAZAPI_ADMIN_TOKEN to use QR-code connections.',
      },
      { status: 400 },
    )
  }

  const { data: existing, error: existingError } = await supabase
    .from('whatsapp_config')
    .select('id, provider, status, access_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (existingError) {
    console.error('Error fetching whatsapp_config:', existingError)
    return NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 })
  }

  if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
    return NextResponse.json(
      {
        error:
          'This account already has a WhatsApp connection. Disconnect it before connecting a new one.',
      },
      { status: 400 },
    )
  }

  const baseUrl = publicBaseUrl(request)
  if (!baseUrl) {
    return NextResponse.json(
      {
        error:
          "Could not determine this app's public URL for the WhatsApp webhook. Set NEXT_PUBLIC_SITE_URL and try again.",
      },
      { status: 500 },
    )
  }

  // Deterministic and non-secret: account ids are not credentials.
  let created: { instanceId: string; token: string }
  try {
    created = await createInstance(`wacrm-${accountId}`)
  } catch (err) {
    return uazapiFailure(err, 'create-instance')
  }

  const webhookSecret = randomBytes(32).toString('hex')
  try {
    await configureWebhook(
      created.token,
      `${baseUrl}/api/whatsapp/uazapi/webhook/${webhookSecret}`,
    )
  } catch (err) {
    await deleteInstanceQuietly(created.token, 'configure-webhook rollback')
    return uazapiFailure(err, 'configure-webhook')
  }

  let encryptedToken: string
  try {
    encryptedToken = encrypt(created.token)
  } catch (err) {
    console.error('Encryption failed:', err instanceof Error ? err.message : 'Unknown encryption error')
    await deleteInstanceQuietly(created.token, 'encrypt rollback')
    return NextResponse.json(
      {
        error:
          'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
      },
      { status: 500 },
    )
  }

  const now = new Date().toISOString()
  const baseRow = {
    provider: 'uazapi',
    provider_config: { instance_id: created.instanceId },
    webhook_secret: webhookSecret,
    access_token: encryptedToken,
    phone_number_id: null,
    waba_id: null,
    verify_token: null,
    status: 'connecting',
    connected_at: null,
    registered_at: null,
    subscribed_apps_at: null,
    last_registration_error: null,
    updated_at: now,
  }

  // A stale (disconnected) row of either provider is replaced in place so
  // the account's other per-config settings survive the switch.
  const { error: writeError } = existing
    ? await supabase.from('whatsapp_config').update(baseRow).eq('account_id', accountId)
    : await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: userId, ...baseRow })

  if (writeError) {
    console.error('Error saving UAZAPI whatsapp_config:', writeError.message ?? 'unknown error')
    await deleteInstanceQuietly(created.token, 'save rollback')
    return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
  }

  // The replaced row may still own a live instance on the UAZAPI server.
  if (existing?.provider === 'uazapi' && existing.access_token) {
    await deleteUazapiInstanceQuietly(existing.access_token, 'replace')
  }

  return NextResponse.json({ success: true, provider: 'uazapi', status: 'connecting' })
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...},
 *     waba_subscription: { checked, subscribed, app_id_match, error? } }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...',
 *     meta: { code, subcode, fbtrace_id, step, field, message } }
 *   UAZAPI row:
 *   { connected, provider: 'uazapi', status, phone, profileName }
 *
 * Every non-auth response also carries `provider` ('meta' | 'uazapi' |
 * null when nothing is saved) and `availableProviders` ('uazapi' only when
 * the server has UAZAPI configured).
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const availableProviders = listAvailableProviders()

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
          provider: null,
          availableProviders,
        },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token, status, provider, provider_config')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        {
          connected: false,
          reason: 'db_error',
          message: 'Failed to fetch configuration',
          provider: null,
          availableProviders,
        },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
          provider: null,
          availableProviders,
        },
        { status: 200 }
      )
    }

    // UAZAPI rows: report the locally mirrored state only. Live state comes
    // from GET /api/whatsapp/uazapi/status; no token or secret is returned.
    if (config.provider === 'uazapi') {
      const pc = (config.provider_config ?? {}) as {
        phone?: string | null
        profile_name?: string | null
      }
      return NextResponse.json({
        connected: config.status === 'connected',
        provider: 'uazapi',
        availableProviders,
        status: config.status,
        phone: pc.phone ?? null,
        profileName: pc.profile_name ?? null,
      })
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          provider: 'meta',
          availableProviders,
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      )
    }

    // Validate credentials against Meta
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
    } catch (err) {
      const explained = explainMetaError(err, 'verify_number', {
        phoneNumberId: config.phone_number_id,
        wabaId: config.waba_id,
      })
      console.error('[whatsapp/config GET] Meta API verification failed:', explained.metaMessage)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: explained.summary,
          meta: metaErrorPayload(explained),
          provider: 'meta',
          availableProviders,
        },
        { status: 200 }
      )
    }

    // Credentials work. Also report whether the WABA is subscribed to
    // this app — valid credentials with an unsubscribed WABA is exactly
    // the "connected but no messages arrive" state (issue #505). Never
    // fatal: the token may lack whatsapp_business_management and still
    // be fine for sending.
    let wabaSubscription: {
      checked: boolean
      subscribed: boolean | null
      app_id_match: boolean | null
      error?: string
    } = { checked: false, subscribed: null, app_id_match: null }
    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({ wabaId: config.waba_id, accessToken })
        const state = appSubscriptionState(subs, process.env.META_APP_ID)
        wabaSubscription = {
          checked: true,
          subscribed: state.subscribed,
          app_id_match: state.appIdMatch,
        }
      } catch (err) {
        const explained = explainMetaError(err, 'subscribed_apps', { wabaId: config.waba_id })
        wabaSubscription = {
          checked: true,
          subscribed: null,
          app_id_match: null,
          error: explained.summary,
        }
      }
    }

    return NextResponse.json({
      connected: true,
      phone_info: phoneInfo,
      waba_subscription: wabaSubscription,
      provider: 'meta',
      availableProviders,
    })
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with Meta first, then encrypts and stores.
 *
 * Every Meta failure answers `{ error, meta: { code, subcode,
 * fbtrace_id, step, field, message } }` — `error` is the actionable
 * text, `meta` is what to quote to Meta support. 400 = fix it on the
 * form (token / ids / PIN), 502 = Meta has to change something.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()

    // Provider switch. No `provider` (or 'meta') keeps the Meta flow below
    // exactly as it was.
    if (body?.provider !== undefined && body?.provider !== 'meta') {
      if (body.provider === 'uazapi') {
        return await createUazapiConfig(request)
      }
      return NextResponse.json({ error: 'Unknown WhatsApp provider' }, { status: 400 })
    }

    // Saving Meta credentials over a UAZAPI row would leave it marked
    // 'uazapi' with a Meta token and orphan the remote instance (its token
    // overwritten). Refuse before any Meta call; Meta-only rows pass through.
    const { data: currentProvider } = await supabase
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', accountId)
      .maybeSingle()
    if (currentProvider?.provider === 'uazapi') {
      return NextResponse.json(
        {
          error:
            'Disconnect the current WhatsApp (QR) connection before saving Meta credentials.',
        },
        { status: 400 },
      )
    }

    const { phone_number_id, waba_id, access_token, verify_token, pin } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    // Meta ids are decimal digit strings. Catch the classic paste
    // mistakes (the +phone number, a display name, a URL) here with a
    // named field, instead of letting Meta answer "(#100) Unsupported
    // get request" for a value we could have rejected up front.
    if (!isNumericMetaId(phone_number_id)) {
      return NextResponse.json(
        {
          error:
            'Phone Number ID must contain only digits — it is the numeric id shown under Meta → WhatsApp → API Setup, not the phone number itself.',
          field: 'phone_number_id',
        },
        { status: 400 }
      )
    }
    if (waba_id !== undefined && waba_id !== null && waba_id !== '' && !isNumericMetaId(waba_id)) {
      return NextResponse.json(
        {
          error:
            'WhatsApp Business Account ID must contain only digits — copy it from Meta → WhatsApp → API Setup.',
          field: 'waba_id',
        },
        { status: 400 }
      )
    }
    const metaCtx: MetaErrorContext = { phoneNumberId: phone_number_id, wabaId: waba_id || null }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        )
      }
    }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      return metaFailure(err, 'verify_number', metaCtx)
    }

    // The number resolves — now make sure it lives under the WABA the
    // user typed. A foreign-but-valid WABA ID used to save fine and
    // subscribe the *wrong* account, surfacing days later as a webhook
    // that never fires. Failing here names the mismatch instead.
    if (waba_id) {
      let wabaNumbers
      try {
        wabaNumbers = await listWabaPhoneNumbers({
          wabaId: waba_id,
          accessToken: access_token,
        })
      } catch (err) {
        return metaFailure(err, 'waba_phone_numbers', metaCtx)
      }
      if (!phoneNumberBelongsToWaba(wabaNumbers, phone_number_id)) {
        return NextResponse.json(
          {
            error: describeWabaPhoneMismatch(wabaNumbers, phone_number_id, waba_id),
            field: 'waba_id',
            meta: {
              code: null,
              subcode: null,
              fbtrace_id: null,
              step: 'waba_phone_numbers',
              field: 'waba_id',
              message: 'phone_number_id is not listed under waba_id',
            },
          },
          { status: 400 }
        )
      }
    }

    // Look up any pre-existing row for this account. Two reasons: we need
    // to know whether this number is already registered with Meta (so we
    // can skip /register when the user didn't provide a PIN this time
    // around), and we need the stored verify_token — the settings form
    // never shows it, so a save that leaves the field blank must keep it
    // rather than null it out.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id, verify_token')
      .eq('account_id', accountId)
      .maybeSingle()

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = resolveVerifyTokenForSave(
        verify_token,
        existing?.verify_token ?? null
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    let registrationMeta: ReturnType<typeof metaErrorPayload> | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          const explained = explainMetaError(err, 'register', metaCtx)
          registrationError = explained.summary
          registrationMeta = metaErrorPayload(explained)
          console.error('Phone number /register failed:', explained.metaMessage, registrationMeta)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    //
    // A failure here used to be swallowed with a console.warn, which
    // left the user with a green "connected" banner and a webhook that
    // never fired. Without this subscription Meta delivers nothing, so
    // treat it as a failed connect and say why (issue #505). Nothing
    // has been written yet, so the user just fixes the cause and saves
    // again.
    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        return metaFailure(err, 'subscribe_waba', metaCtx)
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      // Insert with both columns: `account_id` is the tenancy key
      // (NOT NULL post-017, UNIQUE so duplicates trip the constraint
      // up-front), `user_id` is the audit column identifying which
      // member of the account saved the config.
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...baseRow,
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        error: registrationError,
        meta: registrationMeta,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // A UAZAPI row owns a remote instance: remove it too (best effort).
    const { data: current } = await supabase
      .from('whatsapp_config')
      .select('provider, access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (current?.provider === 'uazapi') {
      // Deleting the remote instance is irreversible and happens outside
      // RLS, so enforce the admin gate (RLS: settings-class) up front.
      try {
        await requireRole('admin')
      } catch (err) {
        return toErrorResponse(err)
      }
      await deleteUazapiInstanceQuietly(current.access_token, 'delete')
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
