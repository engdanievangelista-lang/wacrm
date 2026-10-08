import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  profile: { account_id: 'acct-1' } as { account_id: string } | null,
  config: { provider: 'uazapi' } as { provider: string | null } | null,
  configError: null as { message: string } | null,
  calls: [] as { table: string; filter: [string, string] }[],
  throwOnCreate: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    if (h.throwOnCreate) throw new Error('boom');
    return {
      auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
      from: (table: string) => ({
        select: () => ({
          eq: (col: string, val: string) => ({
            maybeSingle: async () => {
              h.calls.push({ table, filter: [col, val] });
              if (table === 'profiles') return { data: h.profile, error: null };
              return { data: h.config, error: h.configError };
            },
          }),
        }),
      }),
    };
  },
}));

import { readAccountWhatsAppProvider } from './account-provider';

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.profile = { account_id: 'acct-1' };
  h.config = { provider: 'uazapi' };
  h.configError = null;
  h.calls = [];
  h.throwOnCreate = false;
});

describe('readAccountWhatsAppProvider', () => {
  it("reads the caller account's whatsapp_config provider", async () => {
    await expect(readAccountWhatsAppProvider()).resolves.toBe('uazapi');
    expect(h.calls).toEqual([
      { table: 'profiles', filter: ['user_id', 'user-1'] },
      { table: 'whatsapp_config', filter: ['account_id', 'acct-1'] },
    ]);
  });

  it('returns null without a session, profile or row', async () => {
    h.user = null;
    await expect(readAccountWhatsAppProvider()).resolves.toBeNull();
    h.user = { id: 'user-1' };
    h.profile = null;
    await expect(readAccountWhatsAppProvider()).resolves.toBeNull();
    h.profile = { account_id: 'acct-1' };
    h.config = null;
    await expect(readAccountWhatsAppProvider()).resolves.toBeNull();
  });

  it('never throws (a DB error or client failure reads as no row)', async () => {
    h.configError = { message: 'nope' };
    await expect(readAccountWhatsAppProvider()).resolves.toBeNull();
    h.throwOnCreate = true;
    await expect(readAccountWhatsAppProvider()).resolves.toBeNull();
  });
});
