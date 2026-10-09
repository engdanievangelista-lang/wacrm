'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';
import { UazapiConnection, type UazapiSavedConfig } from './uazapi-connection';
import { WhatsAppConfig } from './whatsapp-config';
import {
  decideProviderSwitch,
  type WhatsAppProvider,
} from './uazapi-connection-state';

/** The documented, token-free fields of GET /api/whatsapp/config. */
interface ConfigInfo {
  provider: WhatsAppProvider | null;
  availableProviders: WhatsAppProvider[];
  connected: boolean;
  status: string | null;
  phone: string | null;
  profileName: string | null;
}

function asProvider(v: unknown): WhatsAppProvider | null {
  return v === 'meta' || v === 'uazapi' ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function fetchConfigInfo(): Promise<ConfigInfo | null> {
  try {
    const res = await fetch('/api/whatsapp/config', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const available = Array.isArray(body.availableProviders)
      ? body.availableProviders
          .map(asProvider)
          .filter((p): p is WhatsAppProvider => p !== null)
      : [];
    return {
      provider: asProvider(body.provider),
      availableProviders: available.length > 0 ? available : ['meta'],
      connected: body.connected === true,
      status: str(body.status),
      phone: str(body.phone),
      profileName: str(body.profileName),
    };
  } catch {
    return null;
  }
}

/**
 * Settings → WhatsApp. `enabled` is decided on the server
 * (`shouldUseProviderPanel`): when false — a Meta-only deployment with no
 * stranded UAZAPI row — this is exactly today's Meta form, with no extra
 * request, loader or selector.
 */
export function WhatsAppProviderPanel({ enabled }: { enabled: boolean }) {
  if (!enabled) return <WhatsAppConfig />;
  return <ProviderSelectorPanel />;
}

/**
 * Connection-type selector that swaps between the Meta form and the
 * QR-code connection; leaving a live connection of the other type asks
 * first and removes it (DELETE /api/whatsapp/config) before switching.
 */
function ProviderSelectorPanel() {
  const t = useTranslations('Settings.whatsapp');
  const tp = useTranslations('Settings.whatsapp.provider');
  const tu = useTranslations('Settings.whatsapp.uazapi');
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<ConfigInfo | null>(null);
  const [selected, setSelected] = useState<WhatsAppProvider>('meta');
  const [pendingSwitch, setPendingSwitch] = useState<WhatsAppProvider | null>(
    null
  );
  const [switching, setSwitching] = useState(false);
  // Re-reading the saved config before deciding on a switch.
  const [checking, setChecking] = useState(false);
  // Remounts the child after its config was deleted under it.
  const [childKey, setChildKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchConfigInfo().then((next) => {
      if (cancelled) return;
      setInfo(next);
      setSelected(next?.provider ?? 'meta');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Background refresh after the child changed the connection. Never
  // unmounts the child (no loading state), so its polling survives.
  const refresh = useCallback(() => {
    fetchConfigInfo().then((next) => {
      if (next) setInfo(next);
    });
  }, []);

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      </section>
    );
  }

  // No selector unless this deployment offers UAZAPI — or the account is
  // already on it (env removed later), so it can still be disconnected.
  const offersUazapi =
    !!info &&
    (info.availableProviders.includes('uazapi') || info.provider === 'uazapi');
  if (!offersUazapi) return <WhatsAppConfig />;

  const requestSwitch = async (target: WhatsAppProvider) => {
    if (target === selected || checking) return;
    // The Meta form may have saved (or removed) a connection since this
    // panel loaded; decide on what is saved now. On a failed re-fetch the
    // cached snapshot decides.
    setChecking(true);
    const fresh = await fetchConfigInfo();
    setChecking(false);
    if (fresh) setInfo(fresh);
    const decision = decideProviderSwitch({
      selected,
      target,
      cached: info,
      fresh,
    });
    if (decision === 'confirm') setPendingSwitch(target);
    else if (decision === 'switch') setSelected(target);
  };

  const confirmSwitch = async () => {
    if (!pendingSwitch) return;
    setSwitching(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      setInfo({
        ...info,
        provider: null,
        connected: false,
        status: null,
        phone: null,
        profileName: null,
      });
      setSelected(pendingSwitch);
      setChildKey((k) => k + 1);
      setPendingSwitch(null);
      refresh();
    } catch {
      toast.error(tp('switchFailed'));
    } finally {
      setSwitching(false);
    }
  };

  const uazapiInitial: UazapiSavedConfig | null =
    info.provider === 'uazapi'
      ? {
          status: info.status,
          phone: info.phone,
          profileName: info.profileName,
        }
      : null;

  const options: {
    value: WhatsAppProvider;
    label: string;
    hint: string;
  }[] = [
    { value: 'meta', label: tp('meta'), hint: tp('metaHint') },
    { value: 'uazapi', label: tp('uazapi'), hint: tp('uazapiHint') },
  ];

  return (
    <div>
      <Card className="mb-6 gap-3 px-5 py-4">
        <div>
          <h2
            id="whatsapp-provider-label"
            className="text-foreground text-sm font-semibold"
          >
            {tp('label')}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {canEditSettings ? tp('description') : tp('adminOnly')}
          </p>
        </div>
        <RadioGroup
          aria-labelledby="whatsapp-provider-label"
          value={selected}
          onValueChange={(v) => void requestSwitch(v as WhatsAppProvider)}
          disabled={!canEditSettings || switching || checking}
          aria-busy={checking}
          className="grid gap-2 sm:grid-cols-2"
        >
          {options.map((o) => (
            <label
              key={o.value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                selected === o.value
                  ? 'border-primary-soft-2 bg-primary-soft'
                  : 'border-border hover:bg-card-2',
                (!canEditSettings || switching || checking) &&
                  'cursor-not-allowed opacity-70'
              )}
            >
              <RadioGroupItem value={o.value} className="mt-0.5" />
              <span className="min-w-0">
                <span className="text-foreground block text-sm font-medium">
                  {o.label}
                </span>
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  {o.hint}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </Card>

      {selected === 'meta' ? (
        <WhatsAppConfig key={`meta-${childKey}`} />
      ) : (
        <section className="animate-in fade-in-50 duration-200">
          <SettingsPanelHead
            title={t('title')}
            description={tu('description')}
          />
          <UazapiConnection
            key={`uazapi-${childKey}`}
            initial={uazapiInitial}
            canCreate={info.availableProviders.includes('uazapi')}
            onChanged={refresh}
          />
        </section>
      )}

      <Dialog
        open={pendingSwitch !== null}
        onOpenChange={(open) => {
          if (!open && !switching) setPendingSwitch(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tp('switchTitle')}</DialogTitle>
            <DialogDescription>
              {pendingSwitch === 'meta'
                ? tp('switchToMetaDesc')
                : tp('switchToUazapiDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingSwitch(null)}
              disabled={switching}
            >
              {tp('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmSwitch}
              disabled={switching}
            >
              {switching ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {tp('switching')}
                </>
              ) : (
                tp('switchConfirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
