import { createClient } from '@/lib/supabase/server';

/**
 * Server-side: the `provider` of the caller account's whatsapp_config row
 * ('meta' | 'uazapi'), or null when there is no session, profile or row.
 *
 * Used by the Settings page on deployments without UAZAPI to spot an
 * account still stranded on a UAZAPI row (so it can be disconnected).
 * Never throws: any failure reads as "no row", which renders the plain
 * Meta form. Selects only the provider column — no token leaves the DB.
 */
export async function readAccountWhatsAppProvider(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!profile?.account_id) return null;

    const { data, error } = await supabase
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', profile.account_id)
      .maybeSingle();
    if (error || !data) return null;
    return typeof data.provider === 'string' ? data.provider : null;
  } catch {
    return null;
  }
}
