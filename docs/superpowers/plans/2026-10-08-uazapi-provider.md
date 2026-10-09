# UAZAPI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account connect WhatsApp through UAZAPI (QR code, unofficial) as an alternative to the Meta Cloud API, without changing Meta behaviour.

**Architecture:** A provider boundary (`src/lib/whatsapp/providers/`) with a Meta adapter (thin wrapper over `meta-api.ts`) and a UAZAPI adapter. Inbound persistence is extracted from the Meta webhook route into `src/lib/whatsapp/inbound/` and shared with a new UAZAPI webhook route that normalises UAZAPI events first. Settings gets a provider selector and a QR connection panel.

**Tech Stack:** Next.js 16 (breaking changes: read `node_modules/next/dist/docs/` before route-handler code, per `AGENTS.md`), Supabase (Postgres + RLS), next-intl, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-08-uazapi-provider-design.md`

## Global Constraints

- Env (server-only): `UAZAPI_URL`, `UAZAPI_ADMIN_TOKEN`. If unset, UAZAPI is not offered and Meta-only deployments behave exactly as today.
- UAZAPI auth: header `token` (instance) / `admintoken` (admin endpoints). Rate limit 10 req/s per instance (burst 20), over-limit is `429` with `Retry-After`.
- One provider per account (`UNIQUE(account_id)` stays). Switching deletes the current config after UI confirmation.
- `whatsapp_config`: `provider text not null default 'meta'` CHECK in `('meta','uazapi')`; `provider_config jsonb`; `webhook_secret text` unique nullable; instance token encrypted with existing `encrypt()` into `access_token`; `phone_number_id`/`waba_id` nullable with CHECK requiring them when `provider = 'meta'`; `status` CHECK gains `'connecting'`.
- Webhook registration on the instance: events `messages`, `messages_update`, `connection`; `excludeMessages: ['wasSentByApi','isGroupYes','fromMeYes']`; URL `<APP_URL>/api/whatsapp/uazapi/webhook/<secret>`. Webhook auth: secret must match a row (else 404, no detail) AND envelope `token` must equal the stored instance token (else 401).
- Error codes: Meta keeps `meta_error`; UAZAPI uses `provider_error`; unsupported feature uses `unsupported_by_provider` (HTTP 400).
- QR progress by polling every ~3 s; browser never receives `admintoken` or the instance token.
- `messages.status` CHECK allows only `sending, sent, delivered, read, failed`.
- UI strings in all four locales: `messages/en.json`, `es.json`, `ko.json`, `pt.json`.
- **Meta regression rule:** these existing tests must pass with NO edits: `src/lib/whatsapp/send-message.test.ts`, `src/app/api/whatsapp/webhook/route.test.ts`, `src/lib/whatsapp/meta-api*.test.ts`, `src/lib/whatsapp/broadcast-*.test.ts`, `src/app/api/whatsapp/send/route.test.ts`. If one must change, stop and report — Meta behaviour changed.
- Before every commit: `npm run typecheck`, `npm run lint`, `npm test` green.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Same UAZAPI message delivered twice (webhook retry) → one message row, no double unread bump/fan-out (Task 9 test, via the shared idempotent upsert).
- Echo of our own sends or phone-typed messages (`fromMe: true`) and group chats (`isGroup`/`@g.us`) → ignored, no contact created (Task 8 test).
- `@lid`-only or non-numeric `chatid` → skipped, no junk contact (Task 8 test).
- UAZAPI `429` with `Retry-After`, and `401/404` from `/instance/status` (instance deleted, e.g. free servers delete after 1 h) → clear `provider_error` / config marked disconnected, no crash (Tasks 6, 10 tests).
- UAZAPI selected but env unset, or a second provider selected while one is connected → 400 with clear message / requires disconnect (Task 10 test).

## File Structure

Create:
- `supabase/migrations/043_whatsapp_provider.sql` — provider columns + constraints.
- `src/lib/whatsapp/providers/types.ts` — `WhatsAppProvider`, capabilities, row type.
- `src/lib/whatsapp/providers/meta.ts` — Meta adapter.
- `src/lib/whatsapp/providers/uazapi.ts` — UAZAPI adapter.
- `src/lib/whatsapp/providers/index.ts` — `getProvider`, `assertSupports`, `UnsupportedByProviderError`.
- `src/lib/whatsapp/uazapi/client.ts` — HTTP client + env + errors.
- `src/lib/whatsapp/uazapi/instance.ts` — instance lifecycle calls.
- `src/lib/whatsapp/uazapi/normalize.ts` — webhook event → internal shapes.
- `src/lib/whatsapp/inbound/status.ts` — status ladder + `applyMessageStatus`.
- `src/lib/whatsapp/inbound/persist.ts` — contact/conversation/message persistence + fan-out.
- `src/app/api/whatsapp/uazapi/webhook/[secret]/route.ts`, `…/uazapi/connect/route.ts`, `…/uazapi/status/route.ts`.
- `src/components/settings/uazapi-connection.tsx`, `src/components/settings/whatsapp-provider-panel.tsx`.
- `docs/uazapi-provider.md`.

Modify: `src/lib/whatsapp/send-message.ts`, `src/app/api/whatsapp/react/route.ts`, `src/app/api/whatsapp/webhook/route.ts`, `src/app/api/whatsapp/config/route.ts`, `src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts`, `src/app/api/whatsapp/broadcast/route.ts` (+ `broadcast/[id]/resume`), `src/app/api/whatsapp/templates/{submit,sync,[id]}/route.ts`, `src/app/api/whatsapp/media/[mediaId]/route.ts`, `src/components/settings/settings-overview.tsx`, the page that renders `WhatsAppConfig`, `src/types/index.ts`, `.env.local.example`, `CHANGELOG.md`, the four `messages/*.json`.

---

# Slice 1 — Schema and provider boundary (Meta only)

### Task 1: Migration 043 and types

**Files:**
- Create: `supabase/migrations/043_whatsapp_provider.sql`
- Modify: `src/types/index.ts` (the `WhatsAppConfig` type)

**Interfaces:**
- Produces: `WhatsAppConfig` gains `provider: 'meta' | 'uazapi'`, `provider_config: UazapiProviderConfig | null`, `webhook_secret: string | null`, `phone_number_id: string | null`, `waba_id: string | null`, `status: 'connected' | 'connecting' | 'disconnected'`; `UazapiProviderConfig = { instance_id: string; phone?: string; profile_name?: string }`.

- [ ] **Step 1:** Confirm 042 is still the latest file in `supabase/migrations/`; use the next number if not.
- [ ] **Step 2:** Write the migration idempotently (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`), matching the style of `013_*.sql`/`015_*.sql`: add the three columns, relax `phone_number_id`/`waba_id` NOT NULL, add `CHECK (provider <> 'meta' OR phone_number_id IS NOT NULL)`, widen the `status` CHECK to include `'connecting'` (look up the actual constraint name in `001_initial_schema.sql`/later migrations), add a unique index on `webhook_secret`.
- [ ] **Step 3:** Update the TS type; run `npm run typecheck`. Expected: PASS (fix any call site that assumed non-null `phone_number_id` with a narrowing check, without changing Meta behaviour).
- [ ] **Step 4:** Run the Meta regression tests listed in Global Constraints. Expected: PASS.
- [ ] **Step 5:** Commit `feat(whatsapp): add provider columns to whatsapp_config`.

### Task 2: Provider interface and Meta adapter

**Files:**
- Create: `src/lib/whatsapp/providers/types.ts`, `meta.ts`, `index.ts`; Test: `src/lib/whatsapp/providers/meta.test.ts`, `index.test.ts`
- Modify: the spec table (add `automations` capability).

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type ProviderId = 'meta' | 'uazapi'
  export type ProviderFeature = 'templates' | 'interactive' | 'broadcast' | 'automations'
  export interface WhatsAppProvider {
    id: ProviderId
    supports: Record<ProviderFeature, boolean>
    sendText(a: { to: string; text: string; replyToMessageId?: string }): Promise<{ messageId: string }>
    sendMedia(a: { to: string; kind: 'image'|'video'|'document'|'audio'; url: string; caption?: string; filename?: string; replyToMessageId?: string }): Promise<{ messageId: string }>
    sendReaction(a: { to: string; messageId: string; emoji: string }): Promise<void>
  }
  ```
- Produces (`index.ts`): `getProvider(config: WhatsAppConfig): WhatsAppProvider` (decrypts `access_token`); `class UnsupportedByProviderError extends Error { feature: ProviderFeature; provider: ProviderId }`; `assertSupports(config: Pick<WhatsAppConfig,'provider'>, feature: ProviderFeature): void` (static capability table, no decrypt).
- Meta capabilities: all `true`. UAZAPI: all `false` (adapter added in Task 6; `getProvider` throws for `'uazapi'` until then).

- [ ] **Step 1:** Write failing `meta.test.ts`: with `vi.mock('@/lib/whatsapp/meta-api')`, `sendText` calls `sendTextMessage` with `{ phoneNumberId, accessToken, to, text, contextMessageId }` and returns `{ messageId }`; `sendMedia` calls `sendMediaMessage` with `link: url`; `sendReaction` calls `sendReactionMessage`. Failing `index.test.ts`: `assertSupports({provider:'meta'},'templates')` does not throw; `{provider:'uazapi'}` throws `UnsupportedByProviderError` for each feature.
- [ ] **Step 2:** Run `npx vitest run src/lib/whatsapp/providers` → FAIL (modules missing).
- [ ] **Step 3:** Implement the three files; the Meta adapter only maps argument names (read `SendTextMessageArgs`, `SendMediaMessageArgs`, `SendReactionMessageArgs` in `meta-api.ts`).
- [ ] **Step 4:** Run the same command → PASS. Add `automations` to the spec's `supports` line.
- [ ] **Step 5:** Commit `feat(whatsapp): add provider interface and Meta adapter`.

### Task 3: Route send/react through the provider; guard unsupported types

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts`, `src/app/api/whatsapp/react/route.ts`
- Test: new cases in a NEW file `src/lib/whatsapp/send-message.provider.test.ts` (do not edit `send-message.test.ts`).

**Interfaces:**
- Consumes: `getProvider`, `assertSupports` (Task 2).

- [ ] **Step 1:** Write failing tests in `send-message.provider.test.ts` (mock `./providers` and the Supabase client the way `send-message.test.ts` does): (a) config `provider:'uazapi'` + `messageType:'template'` rejects with `SendMessageError` code `unsupported_by_provider`, status 400; same for `interactive`; (b) config `provider:'uazapi'` + text calls `provider.sendText` once and maps a thrown error to `SendMessageError('provider_error', …, 502)`; (c) Meta + text still throws `meta_error` on failure.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** In `sendMessageToConversation`: after loading `config`, for `template`/`interactive` call `assertSupports` and convert `UnsupportedByProviderError` to `SendMessageError`. In `attempt()`, text and media go through `getProvider(config)`; template/interactive branches stay as-is (Meta-only after the guard). Keep the legacy-ciphertext self-heal and the phone-variant retry untouched. Error code is `meta_error` when `config.provider === 'meta'`, else `provider_error`.
- [ ] **Step 4:** In `react/route.ts`, select `*` (not only `phone_number_id, access_token`) and call `getProvider(config).sendReaction`.
- [ ] **Step 5:** Run new tests → PASS; run all Meta regression tests → PASS unedited.
- [ ] **Step 6:** Commit `refactor(whatsapp): send text/media/reactions via provider`.

---

# Slice 2 — Shared inbound persistence

### Task 4: Extract status handling

**Files:**
- Create: `src/lib/whatsapp/inbound/status.ts`; Test: `status.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts` (remove `RECIPIENT_STATUS_LADDER`, `ladderLevel`, `isValidStatusTransition`, body of `handleStatusUpdate`)

**Interfaces:**
- Produces:
  ```ts
  export interface StatusUpdate { externalId: string; status: string; timestampSec: number;
    failure?: { code: number; title: string; details: string | null } }
  export function isValidStatusTransition(current: string, incoming: string): boolean
  export async function applyMessageStatus(u: StatusUpdate): Promise<void>
  ```
  Behaviour identical to the current `handleStatusUpdate` (messages mirror, broadcast_recipients mirror with ladder guard, `message.status_updated` fan-out). The module owns a lazily-created service-role client with the same `createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)` call so the existing test's `@supabase/supabase-js` mock still applies.

- [ ] **Step 1:** Write `status.test.ts` for `isValidStatusTransition`: `delivered→sent` false, `sent→read` true, `failed` from `pending|sent` true and from `delivered|read` false, unknown incoming false, unknown current accepts ladder statuses.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Move the code; the route's loop maps Meta `status` → `StatusUpdate` (`timestampSec = parseInt(status.timestamp)`, `failure` from `errors[0]`) and calls `applyMessageStatus`.
- [ ] **Step 4:** Run `status.test.ts` + `webhook/route.test.ts` (unedited) → PASS.
- [ ] **Step 5:** Commit `refactor(whatsapp): extract inbound status handling`.

### Task 5: Extract message persistence

**Files:**
- Create: `src/lib/whatsapp/inbound/persist.ts`; Test: `persist.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: `WaIdentity` (`wa-identity.ts`).
- Produces:
  ```ts
  export interface InboundContent { contentText: string|null; mediaUrl: string|null; mediaType: string|null; interactiveReplyId: string|null }
  export interface InboundMessage {
    externalId: string; identity: WaIdentity; timestampSec: number
    rawType: string                       // provider type; mapped with the existing ALLOWED_CONTENT_TYPES rules
    replyToExternalId?: string | null
    reaction?: { targetExternalId: string; emoji: string }   // when set, handled as reaction, no message row
    fallbackText?: string | null          // used where the code used message.text?.body
    loadContent: () => Promise<InboundContent>   // called at the same point parseMessageContent is today
  }
  export interface PersistOptions { accountId: string; configOwnerUserId: string; dispatchAutomations: boolean }
  export async function persistInboundMessage(m: InboundMessage, o: PersistOptions): Promise<void>
  ```
  Moves `processMessage` (minus `parseMessageContent`), `findOrCreateContact`, `findContactByWaUserId`, `contactIdentityPatch`, `findOrCreateConversation`, `handleReaction`, `lookupInternalIdByMetaId`, `flagBroadcastReplyIfAny`. Order of side effects is unchanged. When `dispatchAutomations === false`, skip `dispatchInboundToFlows`, `runAutomationsForTrigger` and `dispatchInboundToAiReply`; still run reopen, broadcast-reply flag, and the `conversation.created` / `message.received` public webhook events.

- [ ] **Step 1:** Write failing `persist.test.ts` (mock Supabase and engines like `webhook/route.test.ts` does): with `dispatchAutomations:false` the flow runner, automations and AI reply are NOT called but `dispatchWebhookEvent('message.received')` is; a replayed `externalId` (upsert returns `[]`) triggers no RPC bump and no fan-out.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Move the code; in the Meta route, `processMessage` becomes a thin mapper building an `InboundMessage` (`loadContent` closes over `parseMessageContent(message, accessToken, mirrorMedia ? { accountId } : null)`) and calls `persistInboundMessage(..., { dispatchAutomations: true })`.
- [ ] **Step 4:** Run `persist.test.ts` + `webhook/route.test.ts` (unedited) → PASS; run the whole suite.
- [ ] **Step 5:** Commit `refactor(whatsapp): extract inbound message persistence`.

---

# Slice 3 — UAZAPI backend

### Task 6: UAZAPI client and adapter

**Files:**
- Create: `src/lib/whatsapp/uazapi/client.ts`, `src/lib/whatsapp/providers/uazapi.ts`; Test: `uazapi/client.test.ts`, `providers/uazapi.test.ts`
- Modify: `providers/index.ts` (`getProvider` returns the UAZAPI adapter)

**Interfaces:**
- Produces (`client.ts`):
  ```ts
  export function uazapiEnv(): { baseUrl: string; adminToken: string } | null
  export function isUazapiEnabled(): boolean
  export class UazapiError extends Error { status: number; retryAfterSec?: number }
  export async function uazapiRequest<T>(o: { path: string; method?: 'GET'|'POST'|'DELETE'; token?: string; admin?: boolean; body?: unknown }): Promise<T>
  ```
  Sends `token` or `admintoken` header; non-2xx throws `UazapiError` carrying `status` and `Retry-After` seconds; the message never includes tokens.
- Produces (`providers/uazapi.ts`): `createUazapiProvider(token: string): WhatsAppProvider` — `sendText` → `POST /send/text {number,text,replyid}`; `sendMedia` → `POST /send/media {number,type,file,text,docName,replyid}`; `sendReaction` → `POST /message/react {id,text}`. Returned id is the short WhatsApp id: use `messageid` from the response, else the part of `id` after the last `:`. `to` must be digits only, else throw `UazapiError` ("needs a phone number"). All `supports` false.

- [ ] **Step 1:** Write failing tests with mocked `fetch`: header names; `sendText` body; id normalisation for response `{ id: '5511999999999:ABC', messageid: 'ABC' }` and `{ id: '5511999999999:ABC' }` both → `'ABC'`; `429` with `Retry-After: 7` → `UazapiError.retryAfterSec === 7`; non-numeric `to` rejected; error text contains no token.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(whatsapp): add UAZAPI client and send adapter`.

### Task 7: Instance lifecycle

**Files:**
- Create: `src/lib/whatsapp/uazapi/instance.ts`; Test: `instance.test.ts`

**Interfaces:**
- Consumes: `uazapiRequest`.
- Produces:
  ```ts
  export type InstanceState = 'disconnected' | 'connecting' | 'connected' | 'hibernated'
  export async function createInstance(name: string): Promise<{ instanceId: string; token: string }>   // POST /instance/create (admin)
  export async function configureWebhook(token: string, url: string): Promise<void>                    // POST /webhook, events/exclude per Global Constraints
  export async function connectInstance(token: string): Promise<{ qr: string | null; state: InstanceState }>   // POST /instance/connect; qr = instance.qrcode (data URL)
  export async function getInstanceStatus(token: string): Promise<{ state: InstanceState; qr: string | null; phone: string | null; profileName: string | null }> // GET /instance/status; phone = status.jid.user, qr = instance.qrcode
  export async function disconnectInstance(token: string): Promise<void>   // POST /instance/disconnect
  export async function deleteInstance(token: string): Promise<void>       // DELETE /instance (200 or 202 both OK)
  ```

- [ ] **Step 1:** Write failing tests asserting method/path/header/body of each call using the spec's example responses (create → `token`, `instance.id`; status → `instance.status`, `status.jid.user`, `instance.profileName`, `instance.qrcode`); `deleteInstance` resolves on 202.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(whatsapp): add UAZAPI instance lifecycle calls`.

### Task 8: Webhook event normalisers

**Files:**
- Create: `src/lib/whatsapp/uazapi/normalize.ts`; Test: `normalize.test.ts`

**Interfaces:**
- Consumes: `InboundMessage`, `StatusUpdate` (Tasks 4–5), `WaIdentity`.
- Produces:
  ```ts
  export function normalizeMessagesEvent(body: unknown, deps: { loadMedia: (m: UazapiMessage) => Promise<InboundContent> }): InboundMessage | null
  export function normalizeUpdateEvent(body: unknown): StatusUpdate[]
  export function normalizeConnectionEvent(body: unknown): { state: InstanceState } | null
  ```
  Rules: `messages` → `null` when `message.fromMe`, `message.isGroup`, `chatid` ends `@g.us`/`@lid`/`@newsletter` or the part before `@s.whatsapp.net` is not 8–15 digits. `externalId = message.messageid`; `identity.phone` = digits of `chatid`, `identity.name = senderName`; `timestampSec = floor(messageTimestamp/1000)`; `replyToExternalId = message.quoted` (empty → null); reaction messages (`messageType` containing "reaction") → `reaction: { targetExternalId: message.reaction, emoji: message.text }`; unknown `messageType` maps to `rawType: 'text'` with `fallbackText: message.text || '[<type>]'`; image/video/audio/document/sticker map to the matching `rawType`. `messages_update` → one `StatusUpdate` per `event.MessageIDs[i]` for `type === 'ReadReceipt'`, `state` mapped `Delivered→delivered`, `Read|Played→read`, other states and `GroupReceipts` ignored. `connection` → `instance.status`.

- [ ] **Step 1:** Write failing tests using the exact example payloads from the OpenAPI spec (text message; read receipt; connected/disconnected) plus: `fromMe:true` → null; group `120363…@g.us` → null; `chatid` `300001@lid` → null; quoted reply id carried; `MessageIDs: null` → `[]`; `GroupReceipts` → `[]`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement defensively (all fields optional; never throw on unexpected shapes). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(whatsapp): add UAZAPI webhook normalisers`.

### Task 9: UAZAPI webhook route

**Files:**
- Create: `src/app/api/whatsapp/uazapi/webhook/[secret]/route.ts`; Test: `route.test.ts` alongside

**Interfaces:**
- Consumes: normalisers (Task 8), `persistInboundMessage`, `applyMessageStatus`, `decrypt`, `mirrorInboundMedia`.
- Produces: `export async function POST(request: Request, context: { params: Promise<{ secret: string }> })`, `export const maxDuration = 60`.

- [ ] **Step 1:** Read the dynamic-route and `after()` docs in `node_modules/next/dist/docs/` and mirror `src/app/api/whatsapp/templates/[id]/route.ts` for the `params` Promise shape.
- [ ] **Step 2:** Write failing tests (mock Supabase like `webhook/route.test.ts`): unknown secret → 404 and no processing; wrong envelope `token` → 401; valid `messages` event → 200 and `persistInboundMessage` called with `{ accountId, configOwnerUserId, dispatchAutomations:false }`; the same event twice leads to the idempotent path only (second call inserts nothing — assert via the persist mock being called twice but a real `upsert` replay test lives in Task 5); `messages_update` → `applyMessageStatus` per id; `connection` `disconnected` → config `status` updated to `disconnected`; ignored (`fromMe`) events → 200, nothing persisted.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement: look up the row by `webhook_secret`; compare `body.token` with `decrypt(row.access_token)` using a constant-time compare; parse JSON; return 200 immediately and process inside `after()` (same reason as the Meta route — issue #301). Media: `loadMedia` mirrors from `message.fileURL` through `mirrorInboundMedia` when `row.mirror_inbound_media !== false`, otherwise returns text only.
- [ ] **Step 5:** Run → PASS. **Step 6:** Commit `feat(whatsapp): add UAZAPI inbound webhook`.

### Task 10: Config and QR endpoints

**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts` (GET/POST/DELETE are provider-aware)
- Create: `src/app/api/whatsapp/uazapi/connect/route.ts`, `…/uazapi/status/route.ts`; Test: `config/route.uazapi.test.ts` (new file; do not edit existing config tests), `uazapi/connect/route.test.ts`, `uazapi/status/route.test.ts`

**Interfaces:**
- Consumes: Tasks 6–7, `isUazapiEnabled`, the same auth/role gate the existing config `POST` uses.
- Produces: `GET /api/whatsapp/config` additionally returns `provider`, `availableProviders: ('meta'|'uazapi')[]` (UAZAPI only when enabled), and for UAZAPI `{ status, phone, profileName }` — never tokens. `POST /api/whatsapp/config` with `{ provider: 'uazapi' }`: 400 if UAZAPI not enabled or an existing config is connected/connecting (must disconnect/`DELETE` first); otherwise `createInstance` → `configureWebhook` → insert row (`status:'connecting'`, encrypted token, `webhook_secret` = 32 random bytes hex, `provider_config.instance_id`). `POST /api/whatsapp/uazapi/connect` → `{ qr, state }`. `GET /api/whatsapp/uazapi/status` → `{ state, qr, phone, profileName }`; on `connected` it persists `provider_config.phone/profile_name` and `status:'connected'`; on `UazapiError` 401/404 it sets `status:'disconnected'` and returns `{ state:'disconnected' }`. `DELETE` for UAZAPI calls `deleteInstance` (best-effort, never blocks local delete) then removes the row.

- [ ] **Step 1:** Write failing tests for each behaviour above including the Review Focus cases (env unset → 400; already connected → 400; status 404 → disconnected; response bodies contain no token or admintoken).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; Meta branches of the config route stay byte-for-byte equivalent in behaviour (existing config tests, if any, pass unedited).
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(whatsapp): add UAZAPI config and QR endpoints`.

### Task 11: Guards for Meta-only features

**Files:**
- Modify: `src/lib/flows/meta-send.ts` (`loadAccountMetaCredentials`), `src/lib/automations/meta-send.ts` (its config load, around line 148), `src/app/api/whatsapp/broadcast/route.ts`, `broadcast/[id]/resume/route.ts`, `templates/submit|sync|[id]/route.ts`, `media/[mediaId]/route.ts`
- Test: `src/lib/whatsapp/providers/guards.test.ts`

**Interfaces:**
- Consumes: `assertSupports`, `UnsupportedByProviderError`.

- [ ] **Step 1:** Write failing tests: `loadAccountMetaCredentials` and the automations loader reject with `UnsupportedByProviderError` for a `provider:'uazapi'` row and still return credentials for Meta; broadcast and templates routes answer 400 `{ code: 'unsupported_by_provider' }` for a UAZAPI account (mock the account's config row).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Add `assertSupports(config, 'automations' | 'broadcast' | 'templates')` at each config-load point and map the error to HTTP 400 in routes. Meta behaviour unchanged.
- [ ] **Step 4:** Run new tests + Meta regression tests → PASS.
- [ ] **Step 5:** Commit `feat(whatsapp): guard Meta-only features on non-Meta providers`.

---

# Slice 4 — UI, docs

### Task 12: Settings UI and i18n

**Files:**
- Create: `src/components/settings/whatsapp-provider-panel.tsx`, `uazapi-connection.tsx`; Test: `uazapi-connection.test.tsx` (follow the existing component-test setup if one exists in the repo; otherwise test the polling/state helper extracted into a small pure hook-free function)
- Modify: the settings page/section that renders `WhatsAppConfig` (find with `grep -rn "WhatsAppConfig" src`), `src/components/settings/settings-overview.tsx`, `messages/{en,es,ko,pt}.json` (namespace `Settings.whatsapp`)

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/whatsapp/config`, `POST /api/whatsapp/uazapi/connect`, `GET /api/whatsapp/uazapi/status`.
- `WhatsAppProviderPanel`: fetches config; if `availableProviders` is only `['meta']` renders `<WhatsAppConfig />` unchanged with no selector; otherwise a selector ("Meta (official API)" / "UAZAPI (QR code)") rendering `WhatsAppConfig` or `UazapiConnection`; switching while connected asks for confirmation then calls `DELETE`.
- `UazapiConnection`: states not-connected → "Generate QR" → QR image + polling every 3 s with an "expired / generate new QR" action → connected (number, profile) → disconnect. Permanent notice: unofficial API, number ban risk, and that templates, broadcast, flows, automations and AI auto-reply are unavailable.
- `settings-overview.tsx`: connection status/number work when `provider = 'uazapi'` (no `phone_number_id`).

- [ ] **Step 1:** Add every new string to all four locale files (same keys everywhere; a missing key in any locale fails the existing i18n check if present — run it, else diff the key sets).
- [ ] **Step 2:** Write the failing component/state test (polling stops on `connected`; stops on unmount; expired QR shows the regenerate action).
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement; `whatsapp-config.tsx` is not edited.
- [ ] **Step 5:** `npm run typecheck && npm run lint && npm test` → PASS.
- [ ] **Step 6:** Run the app (`run` skill or `npm run dev`) with `UAZAPI_URL`/`UAZAPI_ADMIN_TOKEN` unset: Settings shows today's Meta form with no selector. With them set to a real UAZAPI server: complete a QR link and exchange one text message each way. If no real server is available, say so explicitly in the PR instead of claiming it works.
- [ ] **Step 7:** Commit `feat(settings): add WhatsApp provider selector and UAZAPI QR connection`.

### Task 13: Docs and changelog

**Files:**
- Create: `docs/uazapi-provider.md`
- Modify: `.env.local.example`, `CHANGELOG.md`, `README.md` (one line linking the doc)

- [ ] **Step 1:** Document: env vars, what UAZAPI v1 supports and does not (copy the spec's out-of-scope list), unofficial-API ban risk, instance auto-deletion on free servers, how switching providers works.
- [ ] **Step 2:** Add commented `UAZAPI_URL` / `UAZAPI_ADMIN_TOKEN` entries to `.env.local.example`; add a CHANGELOG entry under Unreleased.
- [ ] **Step 3:** `npm run format:check` → PASS. **Step 4:** Commit `docs: document UAZAPI provider`.

---

## Self-review (spec coverage)

- Spec §1 data model → Task 1. §2 boundary → Tasks 2, 3, 11. §3 QR flow → Tasks 7, 10; webhook → Tasks 8, 9; shared persistence → Tasks 4, 5. §4 UI → Task 12. §5 testing → per-task tests + regression rule. §6 slices → slice headings.
- Spec correction: `supports` gains `automations` (flows/automations/AI all send through `flows/meta-send` / `automations/meta-send`); applied in Task 2.
- Open items from the spec stay open and are verified, not assumed: send-response id format (Task 6 tests both shapes; confirm against a live server in Task 12 step 6), instance lifecycle (Task 10: the UI's "Disconnect" is `DELETE /api/whatsapp/config`, which logs out and deletes the instance best-effort, then removes the row; there is no keep-instance state in v1), `@lid` senders (skipped, Task 8), 429 surfacing (Task 6).
