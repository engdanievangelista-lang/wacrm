import { decrypt } from '@/lib/whatsapp/encryption';
import { getProvider } from './providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const sendText = vi.fn();
const sendMedia = vi.fn();
const updateSpy = vi.fn();

vi.mock('./providers', async () => {
  const actual =
    await vi.importActual<typeof import('./providers')>('./providers');
  return {
    ...actual,
    getProvider: vi.fn((cfg: { access_token: string }) => {
      // Real getProvider decrypts the token; mimic that.
      decrypt(cfg.access_token);
      return {
        id: 'mock',
        supports: {},
        sendText,
        sendMedia,
        sendReaction: vi.fn(),
      };
    }),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plain-token'),
  encrypt: vi.fn((v: string) => v),
  isLegacyFormat: vi.fn(() => false),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('not used');
  },
}));

import { sendMessageToConversation, SendMessageError } from './send-message';

function makeDb(provider: 'meta' | 'uazapi'): SupabaseClient {
  const results: Record<string, unknown> = {
    conversations: {
      id: 'cv-1',
      contact: { id: 'ct-1', phone: '5511999990000' },
    },
    whatsapp_config: {
      id: 'cfg-1',
      provider,
      phone_number_id: 'pn-1',
      access_token: 'enc',
    },
  };
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'insert']) {
        chain[m] = () => chain;
      }
      chain.update = (...a: unknown[]) => {
        updateSpy(...a);
        return chain;
      };
      chain.single = async () => ({ data: results[table], error: null });
      chain.maybeSingle = chain.single;
      return chain;
    },
  } as unknown as SupabaseClient;
}

const base = { conversationId: 'cv-1' };

describe('sendMessageToConversation — provider routing', () => {
  beforeEach(() => {
    sendText.mockReset();
    sendMedia.mockReset();
    updateSpy.mockReset();
    vi.mocked(getProvider).mockClear();
    vi.mocked(decrypt).mockReset();
    vi.mocked(decrypt).mockReturnValue('plain-token');
  });

  it('rejects template for a non-Meta provider', async () => {
    const err = await sendMessageToConversation(makeDb('uazapi'), 'acct-1', {
      ...base,
      messageType: 'template',
      templateName: 'hello',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('unsupported_by_provider');
    expect(err.status).toBe(400);
    expect(getProvider).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects interactive for a non-Meta provider', async () => {
    const err = await sendMessageToConversation(makeDb('uazapi'), 'acct-1', {
      ...base,
      messageType: 'interactive',
      interactivePayload: {
        kind: 'buttons',
        body: 'Pick',
        buttons: [{ id: 'a', title: 'A' }],
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('unsupported_by_provider');
    expect(err.status).toBe(400);
    expect(getProvider).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('maps a uazapi text failure to provider_error (502)', async () => {
    sendText.mockRejectedValue(new Error('boom'));
    const err = await sendMessageToConversation(makeDb('uazapi'), 'acct-1', {
      ...base,
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('provider_error');
    expect(err.status).toBe(502);
  });

  it('maps a decrypt failure on a uazapi config to provider_error (502)', async () => {
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error('bad ciphertext');
    });
    const err = await sendMessageToConversation(makeDb('uazapi'), 'acct-1', {
      ...base,
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('provider_error');
    expect(err.status).toBe(502);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('keeps meta_error for a Meta text failure', async () => {
    sendText.mockRejectedValue(new Error('boom'));
    const err = await sendMessageToConversation(makeDb('meta'), 'acct-1', {
      ...base,
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('meta_error');
    expect(err.message).toBe('Meta API error: boom');
    expect(err.status).toBe(502);
  });
});
