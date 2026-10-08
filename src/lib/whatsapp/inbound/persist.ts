import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { identityDisplayName, type WaIdentity } from '@/lib/whatsapp/wa-identity'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
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

/** Parsed body of an inbound message (what parseMessageContent returns). */
export interface InboundContent {
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option. Null for everything else.
   */
  interactiveReplyId: string | null
}

/**
 * Provider-neutral inbound message. Each provider's webhook maps its own
 * payload into this shape and hands it to `persistInboundMessage`.
 *
 * The caller must already have checked that `identity` is usable
 * (`hasUsableIdentity`) — a delivery with neither a phone nor a BSUID has
 * no key to find or create a contact under.
 */
export interface InboundMessage {
  /** Provider message id — stored as `messages.message_id`. */
  externalId: string
  identity: WaIdentity
  timestampSec: number
  /**
   * Provider message type; mapped with the ALLOWED_CONTENT_TYPES rules
   * (sticker→image, button→interactive, else text).
   */
  rawType: string
  /** Provider id of the message being swipe-replied to, if any. */
  replyToExternalId?: string | null
  /** When set, handled as a reaction: no message row is written. */
  reaction?: { targetExternalId: string; emoji: string }
  /** Text fallback when the parsed content carries none. */
  fallbackText?: string | null
  /**
   * Parses the content (and fetches/mirrors media). Called AFTER the
   * reaction short-circuit so reactions skip the media fetch.
   */
  loadContent: () => Promise<InboundContent>
}

export interface PersistOptions {
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string
  /**
   * False skips the flow runner, automation triggers and AI auto-reply.
   * Reopen, broadcast-reply flagging and the public webhook events
   * (`conversation.created` / `message.received`) still run.
   */
  dispatchAutomations: boolean
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  reaction: { targetExternalId: string; emoji: string },
  conversationId: string,
  contactId: string
) {
  if (!reaction.targetExternalId) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.targetExternalId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.targetExternalId
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

export async function persistInboundMessage(
  m: InboundMessage,
  o: PersistOptions
): Promise<void> {
  const { accountId, configOwnerUserId } = o
  const identity = m.identity

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    identity
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before loadContent (parseMessageContent) so the media-URL fetch
  // is skipped.
  if (m.reaction) {
    await handleReaction(m.reaction, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await m.loadContent()

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (m.replyToExternalId) {
    replyToInternalId = await lookupInternalIdByMetaId(
      m.replyToExternalId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        m.replyToExternalId
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_type, template_name, message_id, status,
  //   created_at

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(m.rawType)
    ? m.rawType
    : m.rawType === 'sticker'
      ? 'image'         // stickers are images
      : m.rawType === 'button'
        ? 'interactive' // template quick-reply tap (issue #478)
        : 'text'        // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert. Meta retries webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message.id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert — an empty result means this delivery
  // was a replay. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        // Meta's MIME type for the attachment (migration 039). Was
        // discarded before, which forced the download path to guess an
        // extension from the fetched blob — impossible to do until the
        // bytes had already been fetched successfully.
        media_type: mediaType,
        message_id: m.externalId,
        status: 'delivered',
        created_at: new Date(m.timestampSec * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'. Migration 010 added
        // the column; null for every other content_type so existing inserts
        // behave identically.
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      m.externalId
    )
    return
  }

  // Update conversation. The unread bump is done DB-side (migration 037's
  // bump_conversation_on_inbound) rather than as a read-modify-write of the
  // snapshot loaded above: two inbound messages for the same conversation
  // can process concurrently, and computing `snapshot + 1` in the app let
  // both reads see the same value and write the same increment, losing one
  // (issue #369). The RPC increments in a single UPDATE and refreshes the
  // last-message summary in the same statement.
  const { error: convError } = await supabaseAdmin().rpc(
    'bump_conversation_on_inbound',
    {
      p_conversation_id: conversation.id,
      p_last_message_text: contentText || `[${m.rawType}]`,
    }
  )

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate conditional statement rather than a `status` field on the
  // update above so the write can be gated on the row's CURRENT status in
  // SQL — see the helper for why that matters.
  await reopenClosedConversation(supabaseAdmin(), conversation)

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  //
  // Skipped entirely when the caller disabled automation dispatch
  // (`dispatchAutomations: false`); the message is then treated as not
  // consumed, but no automation triggers or AI reply run either.
  // ============================================================
  let flowConsumed = false
  if (o.dispatchAutomations) {
    const flowResult = await dispatchInboundToFlows({
      accountId,
      userId: configOwnerUserId,
      contactId: contactRecord.id,
      conversationId: conversation.id,
      message:
        interactiveReplyId
          ? {
              kind: 'interactive_reply',
              reply_id: interactiveReplyId,
              reply_title: contentText ?? '',
              meta_message_id: m.externalId,
            }
          : {
              kind: 'text',
              text: contentText ?? m.fallbackText ?? '',
              meta_message_id: m.externalId,
            },
      isFirstInboundMessage,
    })
    flowConsumed = flowResult.consumed
  }

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? m.fallbackText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run. That is issue #301's failure mode
  // recurring one level down, and it's what issue #409 reported as runs
  // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  if (o.dispatchAutomations) {
    for (const triggerType of automationTriggers) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contactRecord.id,
        context: {
          message_text: inboundText,
          conversation_id: conversation.id,
          // Only set on interactive taps; drives the interactive_reply
          // trigger's exact-id match.
          interactive_reply_id: interactiveReplyId ?? undefined,
        },
      }).catch((err) => console.error('[automations] dispatch failed:', err))
    }
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (
    o.dispatchAutomations &&
    !flowConsumed &&
    !interactiveReplyId &&
    inboundText.trim()
  ) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
      // Lets the bot show "typing…" (and mark the message read) while
      // the reply is generated.
      inboundMessageId: m.externalId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: m.externalId,
    content_type: contentType,
    text: contentText,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in persistInboundMessage. */
  wasCreated: boolean
}

/**
 * Look a contact up by BSUID. Exact match on the column backing
 * migration 040's unique index — no fuzzy matching, because a BSUID is
 * an opaque identifier with exactly one correct spelling.
 */
async function findContactByWaUserId(
  accountId: string,
  waUserId: string
): Promise<ContactRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle()

  if (error) {
    console.error('[webhook] BSUID contact lookup failed:', error.message)
    return null
  }
  return data ?? null
}

/**
 * Fields worth writing back onto a contact we just matched, given what
 * this delivery told us. Returns null when nothing changed, so the
 * common case costs no UPDATE.
 *
 * The BSUID backfill is the important one: it stamps the id onto a
 * contact we have only ever known by phone, so the NEXT message from
 * that person — which may well arrive with no phone number at all —
 * still resolves to this same row instead of forking a new one.
 * Likewise a phone backfill upgrades a BSUID-only contact the moment
 * Meta discloses the number, making them reachable by every existing
 * phone-based code path.
 */
function contactIdentityPatch(
  existing: ContactRow,
  identity: WaIdentity
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  // Only ever from a label Meta actually supplied. `identityDisplayName`
  // falls back to the phone number / BSUID, which is the right choice
  // for a brand-new row but would clobber an agent's hand-edited name
  // on every inbound message from a contact with no WhatsApp profile
  // name.
  const name = identity.name || identity.waUsername
  if (name && name !== existing.name) patch.name = name

  if (identity.waUserId && identity.waUserId !== existing.wa_user_id) {
    patch.wa_user_id = identity.waUserId
  }
  if (
    identity.waParentUserId &&
    identity.waParentUserId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = identity.waParentUserId
  }
  if (identity.waUsername && identity.waUsername !== existing.wa_username) {
    patch.wa_username = identity.waUsername
  }
  // Only ever fills a blank. An existing number is left alone — the
  // send path's variant retry already owns correcting it, and Meta's
  // formatting differences are not a reason to rewrite it.
  if (identity.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = identity.phone
  }

  return Object.keys(patch).length > 0 ? patch : null
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  identity: WaIdentity
): Promise<ContactOutcome | null> {
  // BSUID first when we have one. It's stable per (user, business
  // portfolio) and, unlike the phone number, Meta will keep sending it
  // — so it's the key that survives a customer adopting a username.
  let existingContact: ContactRow | null = identity.waUserId
    ? await findContactByWaUserId(accountId, identity.waUserId)
    : null

  // Fall back to the phone. The shared helper pre-filters in SQL by the
  // last-8-digit suffix (so we don't pull every contact on every
  // inbound message) then applies the strict `phonesMatch` in JS on the
  // small candidate set. The same helper backs the manual contact form
  // and CSV import, so all three paths agree on what "same number"
  // means (issue #212).
  if (!existingContact && identity.phone) {
    existingContact = await findExistingContact(
      supabaseAdmin(),
      accountId,
      identity.phone,
    )
  }

  if (existingContact) {
    const patch = contactIdentityPatch(existingContact, identity)
    if (patch) {
      const { data: updated, error: updateError } = await supabaseAdmin()
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
        .select()
        .maybeSingle()

      if (updateError) {
        // A BSUID backfill can lose a race with a concurrent delivery
        // that already claimed it for another row. Not fatal — the
        // message still belongs to the contact we matched.
        console.error(
          '[webhook] contact identity backfill failed:',
          updateError.message
        )
      } else if (updated) {
        existingContact = updated
      }
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  //
  // `phone` stays NOT NULL in the schema, so a BSUID-only sender is
  // stored with '' — which migration 022's partial unique index
  // tolerates, and migration 040's BSUID index is what keeps them
  // unique instead.
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: identity.phone,
      name: identityDisplayName(identity),
      wa_user_id: identity.waUserId,
      wa_parent_user_id: identity.waParentUserId,
      wa_username: identity.waUsername,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and a unique
    // index (022's phone, or 040's BSUID) rejected the duplicate.
    // Re-resolve the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = identity.waUserId
        ? await findContactByWaUserId(accountId, identity.waUserId)
        : null
      if (raced) return { contact: raced, wasCreated: false }
      if (identity.phone) {
        const racedByPhone = await findExistingContact(
          supabaseAdmin(),
          accountId,
          identity.phone
        )
        if (racedByPhone) return { contact: racedByPhone, wasCreated: false }
      }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
