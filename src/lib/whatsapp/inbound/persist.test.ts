import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
// Mirrors the Supabase / engine mocks in webhook/route.test.ts.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByMetaId` resolves (reply context / reaction target). */
    messageLookup: null as { id: string } | null,
    /** Rows the conversation lookup returns; [] forces a create. */
    existingConversations: [
      { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    ] as Record<string, unknown>[],
    conversationInserts: [] as Record<string, unknown>[],
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    reactionUpserts: [] as Record<string, unknown>[],
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'conversations':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: h.state.existingConversations,
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
            insert: (row: Record<string, unknown>) => {
              h.state.conversationInserts.push(row)
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: { id: 'conv-new', ...row },
                      error: null,
                    }),
                }),
              }
            },
          }
        case 'broadcast_recipients':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }
        case 'contacts':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }
        case 'messages':
          return {
            select: (_columns: string, options?: { head?: boolean }) =>
              options?.head
                ? {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({
                          count: h.state.priorCustomerMsgCount,
                          error: null,
                        }),
                    }),
                  }
                : {
                    eq: () => ({
                      eq: () => ({
                        maybeSingle: () =>
                          Promise.resolve({
                            data: h.state.messageLookup,
                            error: null,
                          }),
                      }),
                    }),
                  },
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
          }
        case 'message_reactions':
          return {
            upsert: (row: Record<string, unknown>) => {
              h.state.reactionUpserts.push(row)
              return Promise.resolve({ error: null })
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import {
  persistInboundMessage,
  type InboundMessage,
  type PersistOptions,
} from './persist'

const OPTIONS: PersistOptions = {
  accountId: 'acc-1',
  configOwnerUserId: 'user-1',
  dispatchAutomations: true,
}

function textMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    externalId: 'ext-1',
    identity: {
      phone: '15551230000',
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
      name: 'Ada',
    },
    timestampSec: 1700000000,
    rawType: 'text',
    fallbackText: 'hello',
    loadContent: vi.fn(async () => ({
      contentText: 'hello',
      mediaUrl: null,
      mediaType: null,
      interactiveReplyId: null,
    })),
    ...overrides,
  }
}

function webhookEvents(): string[] {
  return h.dispatchWebhookEvent.mock.calls.map((c) => c[2] as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.messageLookup = null
  h.state.existingConversations = [
    { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
  ]
  h.state.conversationInserts = []
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.reactionUpserts = []
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockResolvedValue(undefined)
})

describe('persistInboundMessage', () => {
  it('persists a genuine message and fans out when dispatchAutomations is true', async () => {
    await persistInboundMessage(textMessage(), OPTIONS)

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      conversation_id: 'conv-1',
      message_id: 'ext-1',
      content_type: 'text',
      content_text: 'hello',
      created_at: new Date(1700000000 * 1000).toISOString(),
    })
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.runAutomationsForTrigger).toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ inboundMessageId: 'ext-1' }),
    )
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'message.received',
      expect.objectContaining({ whatsapp_message_id: 'ext-1' }),
    )
  })

  it('with dispatchAutomations:false skips flows, automations and AI but still emits message.received', async () => {
    await persistInboundMessage(textMessage(), {
      ...OPTIONS,
      dispatchAutomations: false,
    })

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(webhookEvents()).toEqual(['message.received'])
  })

  it('a replayed externalId is a no-op: no RPC bump and no fan-out', async () => {
    h.state.messageUpsertResult = []

    await persistInboundMessage(textMessage(), OPTIONS)

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('a reaction never inserts a message row nor loads content, but still emits conversation.created', async () => {
    h.state.existingConversations = []
    h.state.messageLookup = { id: 'internal-target' }
    const loadContent = vi.fn()

    await persistInboundMessage(
      textMessage({
        rawType: 'reaction',
        reaction: { targetExternalId: 'ext-target', emoji: '👍' },
        loadContent,
      }),
      OPTIONS,
    )

    expect(loadContent).not.toHaveBeenCalled()
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.reactionUpserts).toEqual([
      expect.objectContaining({
        message_id: 'internal-target',
        conversation_id: 'conv-new',
        actor_type: 'customer',
        actor_id: 'contact-1',
        emoji: '👍',
      }),
    ])
    expect(webhookEvents()).toEqual(['conversation.created'])
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('uses fallbackText for flows/automations when content has no text', async () => {
    await persistInboundMessage(
      textMessage({
        rawType: 'audio',
        fallbackText: 'fb',
        loadContent: async () => ({
          contentText: null,
          mediaUrl: '/m',
          mediaType: 'audio/ogg',
          interactiveReplyId: null,
        }),
      }),
      OPTIONS,
    )

    expect(h.state.rpcCalls[0].args).toMatchObject({
      p_last_message_text: '[audio]',
    })
    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { kind: 'text', text: 'fb', meta_message_id: 'ext-1' },
      }),
    )
  })
})
