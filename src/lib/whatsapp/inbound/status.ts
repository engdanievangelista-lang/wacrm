import { createClient } from '@supabase/supabase-js'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

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

export interface StatusUpdate {
  externalId: string
  status: string
  timestampSec: number
  failure?: { code: number; title: string; details: string | null }
  /**
   * Tenant scope. When set, only `messages` / `broadcast_recipients` rows
   * belonging to this account are touched, and the status webhook fires
   * only for it. Required for providers whose payloads are not signed by
   * the platform (UAZAPI): message ids are not unique across numbers, so
   * an unscoped update would let one tenant flip another tenant's rows.
   * Unset (Meta, whose payloads are signed) keeps the global behaviour.
   */
  accountId?: string
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
export function isValidStatusTransition(
  current: string,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

export async function applyMessageStatus(u: StatusUpdate): Promise<void> {
  if (u.accountId) {
    await applyScopedMessageStatus(u, u.accountId)
    return
  }

  // Meta's reason for a failed send (#535). Only read on `failed`; a
  // later non-failed status for the same wamid leaves the error
  // columns alone rather than clearing them, so the reason survives.
  const failure = u.failure ?? null

  if (failure) {
    console.warn(
      `WhatsApp message ${u.externalId} failed: [${failure.code}] ${failure.title}` +
        (failure.details ? ` — ${failure.details}` : '')
    )
  }

  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  const messageUpdate: Record<string, unknown> = { status: u.status }
  if (failure) {
    messageUpdate.error_code = failure.code
    messageUpdate.error_title = failure.title
    messageUpdate.error_details = failure.details
  }
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update(messageUpdate)
    .eq('message_id', u.externalId)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(u.timestampSec * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', u.externalId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, u.status)
  ) {
    const update: Record<string, unknown> = { status: u.status }
    if (u.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (u.status === 'delivered') update.delivered_at = tsIso
    if (u.status === 'read') update.read_at = tsIso
    // broadcast_recipients already has a free-text error_message column
    // (migration 001), so the reason is folded into it rather than
    // adding three more columns there.
    if (failure) {
      update.error_message =
        `[${failure.code}] ${failure.title}` +
        (failure.details ? `: ${failure.details}` : '')
    }

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', u.externalId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: u.externalId,
          conversation_id: msgRow.conversation_id,
          status: u.status,
        }
      )
    }
  }
}

/**
 * Account-scoped variant of `applyMessageStatus`. Every read and write is
 * filtered through the owning account (`conversations!inner(account_id)`
 * for messages, `broadcasts!inner(account_id)` for broadcast recipients),
 * so a status event can only ever touch the caller's own rows.
 */
async function applyScopedMessageStatus(
  u: StatusUpdate,
  accountId: string
): Promise<void> {
  const failure = u.failure ?? null

  if (failure) {
    console.warn(
      `WhatsApp message ${u.externalId} failed: [${failure.code}] ${failure.title}` +
        (failure.details ? ` — ${failure.details}` : '')
    )
  }

  // 1) Resolve this account's message rows for the id, then update by
  //    primary key. An id that only exists in another account resolves to
  //    nothing and nothing is written.
  const { data: ownRows, error: lookupErr } = await supabaseAdmin()
    .from('messages')
    .select('id, conversation_id, conversations!inner(account_id)')
    .eq('message_id', u.externalId)
    .eq('conversations.account_id', accountId)

  if (lookupErr) {
    console.error('Error resolving message for status update:', lookupErr)
  }
  const messageRows = (ownRows ?? []) as { id: string; conversation_id: string }[]

  if (messageRows.length > 0) {
    const messageUpdate: Record<string, unknown> = { status: u.status }
    if (failure) {
      messageUpdate.error_code = failure.code
      messageUpdate.error_title = failure.title
      messageUpdate.error_details = failure.details
    }
    const { error: msgErr } = await supabaseAdmin()
      .from('messages')
      .update(messageUpdate)
      .in(
        'id',
        messageRows.map((r) => r.id)
      )
    if (msgErr) {
      console.error('Error updating message status:', msgErr)
    }
  }

  // 2) Broadcast recipient, scoped through its parent broadcast's account.
  const tsIso = new Date(u.timestampSec * 1000).toISOString()
  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status, broadcasts!inner(account_id)')
    .eq('whatsapp_message_id', u.externalId)
    .eq('broadcasts.account_id', accountId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (recipient && isValidStatusTransition(recipient.status, u.status)) {
    const update: Record<string, unknown> = { status: u.status }
    if (u.status === 'sent') update.sent_at = tsIso
    if (u.status === 'delivered') update.delivered_at = tsIso
    if (u.status === 'read') update.read_at = tsIso
    if (failure) {
      update.error_message =
        `[${failure.code}] ${failure.title}` +
        (failure.details ? `: ${failure.details}` : '')
    }
    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)
    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out — only for this account, and only when it owns a
  //    matching message.
  if (messageRows.length > 0) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.status_updated', {
      whatsapp_message_id: u.externalId,
      conversation_id: messageRows[0].conversation_id,
      status: u.status,
    })
  }
}
