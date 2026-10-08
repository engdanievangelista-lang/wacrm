# UAZAPI provider (QR-code WhatsApp connection)

wacrm can connect an account's WhatsApp number in one of two ways:

- **Meta Cloud API** (default) — the official WhatsApp Business API.
  Setup is described in [WhatsApp setup](https://wacrm.tech/docs/whatsapp-setup)
  and [multi-waba.md](./multi-waba.md).
- **UAZAPI (QR code)** — an unofficial provider. You link a regular
  WhatsApp number by scanning a QR code, like WhatsApp Web, through a
  [UAZAPI](https://uazapi.com) server.

The choice is per wacrm account, and an account has exactly one provider
at a time.

> **Status.** The UAZAPI provider was implemented and tested against the
> vendor's OpenAPI spec (v2.4.4) with mocked HTTP. It has **not** been
> exercised against a live UAZAPI server, and the settings screen has not
> been checked visually in a browser. Two details are unconfirmed:
>
> - The exact format of the message id returned by the send endpoints. The
>   adapter accepts both a bare `messageid` and an `owner:id` shape.
> - The vendor's `/instance/connect` response example is inconsistent in
>   its docs, so the QR code is read from the status endpoint while the
>   UI polls.
>
> Treat a first deployment as something to verify with a spare number.

## Risks

- UAZAPI is **not** an official WhatsApp API and is not endorsed by Meta
  or WhatsApp. Linking a number this way can get the number restricted or
  banned. Do not use a number you cannot afford to lose. The vendor
  recommends WhatsApp Business app accounts.
- Free or demo UAZAPI servers delete instances automatically after about
  one hour. See [Troubleshooting](#troubleshooting).

## When to choose which

Choose **Meta** if you need templates, buttons/lists, broadcasts, flows,
automations or the AI auto-reply, or if the number is business-critical.
Choose **UAZAPI** if you want to try the inbox quickly with a number you
already use in the WhatsApp app and can accept the risks above.

## Requirements

1. **Environment variables** (server-only, never sent to the browser):

   ```
   UAZAPI_URL=https://your-subdomain.uazapi.com
   UAZAPI_ADMIN_TOKEN=your-uazapi-admin-token
   ```

   Your deployment owns the UAZAPI server: wacrm uses the admin token to
   create one instance per account when a user chooses UAZAPI. If either
   variable is unset, the UAZAPI option is not offered and a Meta-only
   deployment behaves exactly as before.

2. **Database migration.** Apply
   `supabase/migrations/043_whatsapp_provider.sql`. It adds `provider`,
   `provider_config` and `webhook_secret` to `whatsapp_config`, makes
   `phone_number_id` optional for non-Meta rows and allows the status
   `connecting`. Existing rows become `provider = 'meta'` automatically.

3. **A publicly reachable URL.** The UAZAPI server calls back into wacrm,
   so set `NEXT_PUBLIC_SITE_URL` to the public address of your deployment
   (scheme + host, no trailing slash). wacrm registers the instance's
   webhook as:

   ```
   <NEXT_PUBLIC_SITE_URL>/api/whatsapp/uazapi/webhook/<secret>
   ```

   for the events `messages`, `messages_update` and `connection`. API-sent
   messages, group messages and messages sent from the linked phone itself
   (`fromMe`) are excluded. If the variable is unset, wacrm falls back to
   the request's host headers (honouring `ALLOWED_INVITE_HOSTS`); if no
   URL can be determined, connecting fails with an error asking you to set
   `NEXT_PUBLIC_SITE_URL`.

## Connecting

Only account admins can configure the connection.

1. Open **Settings → WhatsApp connection** and choose **UAZAPI (QR code)**.
2. Generate the QR code. wacrm creates the instance, registers the
   webhook and shows the code.
3. On the phone, open WhatsApp → **Settings → Linked devices → Link a
   device** and scan the code.
4. The page polls the status; once the phone is linked the connection
   shows as connected, with the phone number and profile name.

## What works in v1

| Supported                | Not supported                                         |
| ------------------------ | ----------------------------------------------------- |
| Receiving messages       | Message templates                                     |
| Sending text and media   | Interactive messages (buttons, lists)                 |
| Reactions                | Broadcasts                                            |
| Delivery and read status | Flows, automations, AI auto-reply                     |
|                          | Messages typed on the phone itself (`fromMe`)         |
|                          | Group chats                                           |
|                          | Contacts that arrive only as `@lid` (no phone number) |

Unsupported features are disabled with a notice in the UI. Calling them
through the API returns HTTP 400 with the error code
`unsupported_by_provider`.

Inbound media links from UAZAPI expire (about two days). When the
account's **Keep inbound attachments** setting is on, wacrm copies
inbound media into your Supabase storage.

## Switching and disconnecting

- **Disconnect** unlinks the number and deletes the UAZAPI instance
  (best-effort), then removes the saved connection.
- Switching provider requires disconnecting the current one first. The UI
  asks for confirmation and deletes the current connection; messages stop
  until the new connection is set up.
- The API enforces this too: saving Meta credentials over a UAZAPI
  connection is refused, and creating a UAZAPI connection while one is
  connected or connecting is refused.

## Troubleshooting

- **No QR code appears, or it expires.** Codes are short-lived. Generate a
  new one. If it never appears, check that `UAZAPI_URL` and
  `UAZAPI_ADMIN_TOKEN` are correct and that the server can reach the
  UAZAPI host.
- **Status says disconnected after about an hour.** Free and demo UAZAPI
  servers delete instances after roughly an hour. The status endpoint then
  reports the connection as disconnected; generate a new QR code. Use a
  paid server for anything lasting.
- **Connected, but no messages arrive.** The webhook cannot reach wacrm.
  Check that `NEXT_PUBLIC_SITE_URL` is the correct public address and that
  `/api/whatsapp/uazapi/webhook/...` is reachable from the UAZAPI server
  (not `localhost`, not behind a login). Messages typed on the phone,
  group chats and `@lid`-only contacts are intentionally ignored.
- **Rate limit (HTTP 429).** The UAZAPI server limits each instance to
  about 10 requests per second. wacrm surfaces the 429 together with the
  `Retry-After` value; retry after that many seconds.

## Security notes

- The instance token is stored encrypted at rest with `ENCRYPTION_KEY`,
  like Meta access tokens.
- The webhook is protected twice: a random per-connection secret in the
  URL path identifies the connection, and the instance token carried in
  each event must match the stored token. Mismatches are rejected.
- The browser never receives tokens or the webhook secret; the status
  endpoint returns only state, QR code, phone and profile name.
- `UAZAPI_ADMIN_TOKEN` stays on the server.
