# UAZAPI provider (QR-code WhatsApp connection) — design

Date: 2026-10-08
Status: draft, awaiting review

## Goal

Add a second way to connect WhatsApp to wacrm next to the official Meta
Cloud API: **UAZAPI**, an unofficial API that links a number by scanning a
QR code from Settings. An account picks one provider. The Meta path must
keep working unchanged.

Success: a user scans the QR, the number shows as connected, and messages
flow in and out of the Inbox. Existing Meta tests pass **without edits**.

## Decisions

| Topic | Decision |
| --- | --- |
| Providers per account | One at a time (keeps `UNIQUE(account_id)`). |
| UAZAPI server | Owned by the deployment: `UAZAPI_URL` + `UAZAPI_ADMIN_TOKEN` (server-only env). wacrm creates the instance itself. |
| v1 scope | Inbox core only: receive, send text, send media, reactions, delivery status. |
| Out of v1 on UAZAPI | Templates, interactive messages, broadcast, flows, automations, AI auto-reply, messages typed on the phone (`fromMe`), groups, `@lid`-only contacts. |
| Architecture | Provider boundary with adapters (not `if (uazapi)` scattered, not a duplicated stack). |
| QR progress | Polling `GET /instance/status` (~3 s), plus the `connection` webhook event as a second signal. |

If `UAZAPI_URL`/`UAZAPI_ADMIN_TOKEN` are unset the UAZAPI option is not
offered and a Meta-only deployment behaves exactly as today.

## 1. Data model

New migration (next free number; latest seen is 042, so expected `043`):

- `whatsapp_config.provider text not null default 'meta'`, CHECK in
  `('meta','uazapi')`. Existing rows become `'meta'`.
- `whatsapp_config.provider_config jsonb` — UAZAPI `instance_id`, linked
  phone number, profile name.
- `whatsapp_config.webhook_secret text` — nullable, unique; routes and
  authenticates the UAZAPI webhook.
- Instance token is encrypted with the existing `encrypt()` and stored in
  `access_token` (stays `NOT NULL`).
- `phone_number_id` and `waba_id` become nullable; CHECK requires them when
  `provider = 'meta'`. The existing `UNIQUE(phone_number_id)` stays valid
  (multiple NULLs allowed).
- `status` CHECK gains `'connecting'`.

Switching provider requires disconnecting: the current config is deleted
after a confirmation dialog. RLS is unchanged (already `account_id`-scoped).

## 2. Provider boundary

New `src/lib/whatsapp/providers/`:

```ts
interface WhatsAppProvider {
  id: 'meta' | 'uazapi'
  sendText({ to, text, replyToMessageId? }): { messageId }
  sendMedia({ to, kind, url, caption?, filename?, replyToMessageId? }): { messageId }
  sendReaction({ to, messageId, emoji }): void
  supports: { templates: boolean; interactive: boolean; broadcast: boolean; automations: boolean }
}
getProvider(config): WhatsAppProvider   // reads config.provider, decrypts token
```

- **Meta adapter**: thin wrapper over `sendTextMessage` / `sendMediaMessage`
  etc. in `meta-api.ts`. No rewrite of `meta-api.ts`.
- **UAZAPI adapter**: `POST /send/text`, `/send/media`, `/message/react`
  with the instance `token` header. Normalises the returned message id so it
  matches ids arriving in `messages_update`.
- **`send-message.ts`**: `attempt()` goes through `getProvider(config)`;
  `template`/`interactive` are guarded by `supports` and throw
  `SendMessageError('unsupported_by_provider', …, 400)`. The phone-variant
  retry stays (Meta-specific error, never triggers for UAZAPI). Error code
  `meta_error` is kept for Meta; UAZAPI uses `provider_error`.
- **Other callers**: `react` and normal send use the interface. Flows
  (`flows/meta-send.ts`), automations (`automations/meta-send.ts`), broadcast,
  templates and AI auto-reply (`lib/ai/auto-reply.ts`, which sends through
  `flows/meta-send`) get an `assertSupports(...)` guard; the UI disables them
  with an explanatory notice when the provider is UAZAPI.

## 3. QR flow and inbound webhook

### QR flow (all UAZAPI calls server-side)

1. User selects UAZAPI → server `POST /instance/create` (`admintoken`),
   generates `webhook_secret`, stores encrypted instance token. Status
   `connecting`.
2. Server `POST /webhook` on the instance: url
   `<APP_URL>/api/whatsapp/uazapi/webhook/<secret>`, events `messages`,
   `messages_update`, `connection`, `excludeMessages: ['wasSentByApi',
   'isGroupYes','fromMeYes']`.
3. `POST /api/whatsapp/uazapi/connect` → `/instance/connect` → QR returned.
4. UI polls `GET /api/whatsapp/uazapi/status` (proxy of `/instance/status`).
   On `connected` the server stores `jid.user` + `profileName`, sets status
   `connected`, polling stops.
5. QR expiry shows "Generate new QR". Disconnect calls `/instance/disconnect`.

The browser never receives `admintoken` or the instance token — only the QR
and the state.

### Inbound webhook `/api/whatsapp/uazapi/webhook/[secret]`

- Auth, two layers: `secret` must match a `whatsapp_config` row (otherwise
  404, no detail), and the envelope `token` must equal the stored instance
  token (otherwise 401). Respond 200 quickly, then process.
- `messages` → normalised to an internal `InboundMessage` (contact from
  `chatid`, text, type, media, `quoted`) → shared persistence path.
- `messages_update` → map `Sent/Delivered/Read/Failed` onto internal
  statuses via the existing status-transition ladder.
- Inbound media → existing `mirror-inbound-media` from `fileURL`.

### Shared inbound persistence (highest risk)

`processMessage` / `handleStatusUpdate` and the contact/conversation lookups
currently live in `src/app/api/whatsapp/webhook/route.ts` (≈1450 lines) and
consume Meta's payload shape. Extract the **persistence** part into
`src/lib/whatsapp/inbound/` taking a normalised `InboundMessage`; Meta keeps
its own normaliser (`parseMessageContent`). `webhook/route.test.ts` must pass
unchanged. The detailed shape of `InboundMessage` is decided after reading
that code in full, at plan time.

## 4. Settings UI

- A thin wrapper reads `provider` and `availableProviders` (from
  `GET /api/whatsapp/config`). Meta-only → renders today's `WhatsAppConfig`
  untouched. Otherwise a selector ("Meta (official API)" / "UAZAPI (QR
  code)") renders `WhatsAppConfig` or a new `UazapiConnection`.
- `UazapiConnection` states: not connected → "Generate QR" → QR with polling
  and expiry → connected (number, profile) → disconnect. Fixed notice: the
  API is unofficial (ban risk) and templates/broadcast/flows/automations/AI
  are unavailable.
- `settings-overview.tsx` reads `whatsapp_config` directly and assumes
  `phone_number_id`; it must handle UAZAPI status/number.
- Strings added to all four locales: `en`, `es`, `ko`, `pt`.
- `whatsapp-config.tsx` (1073 lines) is not grown.

## 5. Testing

- **Meta regression**: `send-message.test.ts`, `webhook/route.test.ts`,
  `meta-api*.test.ts`, `broadcast-*.test.ts` pass with no edits. If one must
  change, stop and flag it — Meta behaviour changed.
- **New**: adapter contract tests (payload, headers, returned id) with
  mocked `fetch`; UAZAPI webhook normaliser (text, media, `quoted`, status,
  `connection`); webhook auth (bad secret 404, bad envelope token 401);
  `assertSupports` guards; status/QR route.
- No tests against a live UAZAPI server; the OpenAPI spec (v2.4.4) is the
  source and anything not verified live is called out in the PR.
- `typecheck`, `lint`, `test` green before each slice.

## 6. Delivery slices (each safe to merge alone)

1. Migration + `providers/` + `send-message.ts` through the provider
   (Meta adapter only; behaviour identical).
2. Extract inbound persistence to `inbound/`; Meta uses it.
3. UAZAPI adapter + endpoints (`connect`, `status`, `webhook`, config) +
   `assertSupports` guards.
4. UI (selector, `UazapiConnection`, overview, 4 locales) + a doc under
   `docs/` + CHANGELOG.

Nothing is user-visible until slice 4; Meta risk is concentrated in slices
1–2, where existing tests are the arbiter.

## Open items to resolve during planning/implementation

- Exact format of the message id returned by `/send/*` vs `messageid` in
  `messages_update` (id normalisation).
- Whether `DELETE /instance` should run on "disconnect" or only on removing
  the provider (instance lifecycle / server instance limit, HTTP 429).
- `@lid`-only senders and their relation to `wa-identity.ts`.
- Per-instance rate limit (10 req/s, burst 20) — send path should surface
  `429`/`Retry-After` as a clear error.
- Next-version docs: `AGENTS.md` requires reading
  `node_modules/next/dist/docs/` before writing Next.js code (route handlers
  with dynamic `[secret]` params in particular).
