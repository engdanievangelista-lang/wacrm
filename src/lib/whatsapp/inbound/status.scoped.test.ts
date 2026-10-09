import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>

// Tiny in-memory fake of the PostgREST builder: applies eq/in filters to
// table rows (embedded-resource filters like `conversations.account_id`
// are stored flat on each row) and records every write.
const h = vi.hoisted(() => ({
  dispatchWebhookEvent: vi.fn(),
  db: {} as Record<string, Row[]>,
  writes: [] as { table: string; payload: Row; ids: unknown[] }[],
  selects: [] as { table: string; cols: string; filters: [string, unknown][] }[],
}))

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const q = {
        op: 'select' as 'select' | 'update',
        cols: '*',
        payload: {} as Row,
        filters: [] as [string, (r: Row) => boolean, unknown][],
      }
      const matched = () => (h.db[table] ?? []).filter((r) => q.filters.every(([, f]) => f(r)))
      const run = () => {
        const rows = matched()
        if (q.op === 'update') {
          for (const r of rows) Object.assign(r, q.payload)
          h.writes.push({ table, payload: q.payload, ids: rows.map((r) => r.id) })
          return { data: null, error: null }
        }
        h.selects.push({
          table,
          cols: q.cols,
          filters: q.filters.map(([c, , v]) => [c, v] as [string, unknown]),
        })
        return { data: rows, error: null }
      }
      const b = {
        select(cols: string) {
          q.cols = cols
          return b
        },
        update(p: Row) {
          q.op = 'update'
          q.payload = p
          return b
        },
        eq(c: string, v: unknown) {
          q.filters.push([c, (r) => r[c] === v, v])
          return b
        },
        in(c: string, vs: unknown[]) {
          q.filters.push([c, (r) => vs.includes(r[c]), vs])
          return b
        },
        limit: () => b,
        maybeSingle: () => {
          const res = run()
          return Promise.resolve({ data: (res.data as Row[] | null)?.[0] ?? null, error: null })
        },
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(ok, bad),
      }
      return b
    },
  }),
}))

import { applyMessageStatus } from './status'

beforeEach(() => {
  h.dispatchWebhookEvent.mockReset().mockResolvedValue(undefined)
  h.writes = []
  h.selects = []
  h.db = {
    messages: [
      { id: 'm-own', message_id: 'WAMID_OWN', conversation_id: 'c-1', status: 'sent', 'conversations.account_id': 'acc-1' },
      { id: 'm-other', message_id: 'WAMID_OTHER', conversation_id: 'c-9', status: 'sent', 'conversations.account_id': 'acc-2' },
      // Same provider id in two tenants (ids are not unique across numbers).
      { id: 'm-dup-1', message_id: 'WAMID_DUP', conversation_id: 'c-1', status: 'sent', 'conversations.account_id': 'acc-1' },
      { id: 'm-dup-2', message_id: 'WAMID_DUP', conversation_id: 'c-9', status: 'sent', 'conversations.account_id': 'acc-2' },
    ],
    broadcast_recipients: [
      { id: 'br-own', whatsapp_message_id: 'WAMID_OWN', status: 'sent', 'broadcasts.account_id': 'acc-1' },
      { id: 'br-other', whatsapp_message_id: 'WAMID_OTHER', status: 'sent', 'broadcasts.account_id': 'acc-2' },
    ],
  }
})

const at = 1788868800

describe('applyMessageStatus with accountId', () => {
  it('updates the account’s own message + recipient and fans out for that account', async () => {
    await applyMessageStatus({ externalId: 'WAMID_OWN', status: 'read', timestampSec: at, accountId: 'acc-1' })

    expect(h.selects.find((s) => s.table === 'messages')).toMatchObject({
      cols: expect.stringContaining('conversations!inner(account_id)'),
      filters: expect.arrayContaining([['conversations.account_id', 'acc-1']]),
    })
    expect(h.selects.find((s) => s.table === 'broadcast_recipients')).toMatchObject({
      cols: expect.stringContaining('broadcasts!inner(account_id)'),
      filters: expect.arrayContaining([['broadcasts.account_id', 'acc-1']]),
    })
    expect(h.writes).toEqual([
      { table: 'messages', payload: { status: 'read' }, ids: ['m-own'] },
      {
        table: 'broadcast_recipients',
        payload: { status: 'read', read_at: new Date(at * 1000).toISOString() },
        ids: ['br-own'],
      },
    ])
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent.mock.calls[0].slice(1)).toEqual([
      'acc-1',
      'message.status_updated',
      { whatsapp_message_id: 'WAMID_OWN', conversation_id: 'c-1', status: 'read' },
    ])
  })

  it('does NOT touch another account’s message or recipient, and fires no fan-out', async () => {
    await applyMessageStatus({ externalId: 'WAMID_OTHER', status: 'read', timestampSec: at, accountId: 'acc-1' })

    expect(h.writes).toEqual([])
    expect(h.db.messages.find((r) => r.id === 'm-other')!.status).toBe('sent')
    expect(h.db.broadcast_recipients.find((r) => r.id === 'br-other')!.status).toBe('sent')
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('with a provider id shared across tenants, only the caller’s row changes', async () => {
    await applyMessageStatus({ externalId: 'WAMID_DUP', status: 'delivered', timestampSec: at, accountId: 'acc-1' })

    expect(h.writes.filter((w) => w.table === 'messages')).toEqual([
      { table: 'messages', payload: { status: 'delivered' }, ids: ['m-dup-1'] },
    ])
    expect(h.db.messages.find((r) => r.id === 'm-dup-2')!.status).toBe('sent')
    expect(h.dispatchWebhookEvent.mock.calls.map((c) => c[1])).toEqual(['acc-1'])
  })

  it('without accountId keeps the global (Meta) behaviour', async () => {
    await applyMessageStatus({ externalId: 'WAMID_DUP', status: 'delivered', timestampSec: at })
    expect(h.writes.filter((w) => w.table === 'messages')).toEqual([
      { table: 'messages', payload: { status: 'delivered' }, ids: ['m-dup-1', 'm-dup-2'] },
    ])
  })
})
