import { resolveSection } from '@/components/settings/settings-sections';
import { shouldUseProviderPanel } from '@/components/settings/uazapi-connection-state';
import { readAccountWhatsAppProvider } from '@/lib/whatsapp/account-provider';
import { isUazapiEnabled } from '@/lib/whatsapp/uazapi/client';

import { SettingsPageClient } from './settings-page-client';

/**
 * Server entry for /settings. Decides, without a browser round trip,
 * whether Settings → WhatsApp needs the provider panel (selector + QR
 * connection) or is today's plain Meta form:
 *  - UAZAPI configured on this server (env only, never sent to the
 *    browser) → provider panel;
 *  - otherwise only an account stranded on a UAZAPI row gets it, so the
 *    row can still be disconnected. That needs one small DB read, done
 *    only while the WhatsApp section is the one being shown (switching
 *    sections changes `?tab=`, which re-renders this page).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const uazapiEnabled = isUazapiEnabled();
  let rowProvider: string | null = null;
  if (!uazapiEnabled) {
    const tab = (await searchParams).tab;
    const section = resolveSection(typeof tab === 'string' ? tab : null);
    if (section === 'whatsapp') {
      rowProvider = await readAccountWhatsAppProvider();
    }
  }

  return (
    <SettingsPageClient
      whatsappProviderPanel={shouldUseProviderPanel({
        uazapiEnabled,
        rowProvider,
      })}
    />
  );
}
