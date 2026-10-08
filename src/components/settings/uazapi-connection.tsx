'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  QrCode,
  RefreshCw,
  Unplug,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { SettingsChip, StatusDot } from './settings-chip';
import {
  initialUazapiState,
  parseRetryAfter,
  uazapiReducer,
  type UazapiErrorKind,
  type UazapiRemoteState,
} from './uazapi-connection-state';

export interface UazapiSavedConfig {
  status: string | null;
  phone: string | null;
  profileName: string | null;
}

interface CallResult {
  ok: boolean;
  /** 0 = the request never got an HTTP answer. */
  status: number;
  body: Record<string, unknown> | null;
  retryAfterSec: number | null;
}

async function call(
  url: string,
  init: RequestInit & { signal?: AbortSignal }
): Promise<CallResult> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      body,
      retryAfterSec: parseRetryAfter(res.headers.get('Retry-After'), body),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { ok: false, status: 0, body: null, retryAfterSec: null };
  }
}

const REMOTE_STATES: UazapiRemoteState[] = [
  'disconnected',
  'connecting',
  'connected',
  'hibernated',
];

function remoteState(v: unknown): UazapiRemoteState {
  return REMOTE_STATES.includes(v as UazapiRemoteState)
    ? (v as UazapiRemoteState)
    : 'disconnected';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Only render a QR the server handed us as an image data URL. */
function safeQr(v: unknown): string | null {
  const s = str(v);
  return s && s.startsWith('data:image/') ? s : null;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * UAZAPI (QR code) WhatsApp connection: generate a QR, poll
 * `GET /api/whatsapp/uazapi/status` until the phone is linked, show the
 * linked number, disconnect. The polling / expiry rules live in the pure
 * `uazapi-connection-state` module.
 */
export function UazapiConnection({
  initial,
  onChanged,
}: {
  /** The saved UAZAPI row (from GET /api/whatsapp/config), or null. */
  initial: UazapiSavedConfig | null;
  /** Called after the connection was created, linked or removed. */
  onChanged?: () => void;
}) {
  const t = useTranslations('Settings.whatsapp.uazapi');
  const { canEditSettings } = useAuth();

  const [state, dispatch] = useReducer(uazapiReducer, undefined, () =>
    initialUazapiState(initial, {
      now: Date.now(),
      canPoll: canEditSettings,
    })
  );

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Aborts every in-flight request on unmount.
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  // The role may resolve after mount: resume a half-finished pairing
  // once we know the viewer is allowed to poll it.
  useEffect(() => {
    if (canEditSettings) dispatch({ type: 'retry_now' });
  }, [canEditSettings]);

  // ---- status polling -------------------------------------------------
  const { shouldPoll, nextPollMs, pollSeq } = state;
  useEffect(() => {
    if (!shouldPoll || nextPollMs === null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await call('/api/whatsapp/uazapi/status', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (r.ok && r.body) {
          dispatch({
            type: 'status_ok',
            state: remoteState(r.body.state),
            qr: safeQr(r.body.qr),
            phone: str(r.body.phone),
            profileName: str(r.body.profileName),
            now: Date.now(),
          });
        } else {
          dispatch({
            type: 'http_error',
            during: 'poll',
            status: r.status,
            retryAfterSec: r.retryAfterSec,
            now: Date.now(),
          });
        }
      } catch (err) {
        if (!isAbort(err)) throw err;
      }
    }, nextPollMs);
    // Unmount or a newer schedule: drop the timer and any answer in flight.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [shouldPoll, nextPollMs, pollSeq, dispatch]);

  // ---- connected transition -------------------------------------------
  // The ref starts at the initial phase, so opening the panel on an
  // already-linked number does not toast.
  const prevPhase = useRef(state.phase);
  useEffect(() => {
    if (state.phase === 'connected' && prevPhase.current !== 'connected') {
      toast.success(t('connectedToast'));
      onChanged?.();
    }
    prevPhase.current = state.phase;
  }, [state.phase, onChanged, t]);

  // ---- actions ---------------------------------------------------------
  const generateQr = useCallback(async () => {
    const signal = lifetime.current?.signal;
    // From idle there is no live instance: create one (the server replaces
    // a stale row). An expired QR keeps its instance and just reconnects.
    const createFirst = state.phase === 'idle';
    dispatch({ type: 'start', now: Date.now() });
    try {
      if (createFirst) {
        const created = await call('/api/whatsapp/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'uazapi' }),
          signal,
        });
        if (!created.ok) {
          dispatch({
            type: 'http_error',
            during: 'start',
            status: created.status,
            retryAfterSec: created.retryAfterSec,
            now: Date.now(),
          });
          return;
        }
        onChanged?.();
      }
      const connected = await call('/api/whatsapp/uazapi/connect', {
        method: 'POST',
        signal,
      });
      if (!connected.ok || !connected.body) {
        dispatch({
          type: 'http_error',
          during: 'start',
          status: connected.status,
          retryAfterSec: connected.retryAfterSec,
          now: Date.now(),
        });
        return;
      }
      dispatch({
        type: 'connect_ok',
        state: remoteState(connected.body.state),
        qr: safeQr(connected.body.qr),
        now: Date.now(),
      });
    } catch (err) {
      if (!isAbort(err)) throw err;
    }
  }, [state.phase, dispatch, onChanged]);

  const retryNow = useCallback(() => dispatch({ type: 'retry_now' }), []);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    dispatch({ type: 'stop' });
    try {
      const r = await call('/api/whatsapp/config', {
        method: 'DELETE',
        signal: lifetime.current?.signal,
      });
      if (!r.ok) {
        toast.error(t('disconnectFailed'));
        // Still pairing: pick the status polling back up.
        dispatch({ type: 'retry_now' });
        return;
      }
      dispatch({ type: 'reset' });
      setConfirmOpen(false);
      toast.success(t('disconnectedToast'));
      onChanged?.();
    } catch (err) {
      if (!isAbort(err)) throw err;
    } finally {
      setDisconnecting(false);
    }
  }, [dispatch, onChanged, t]);

  // ---- render ----------------------------------------------------------
  const errorText = (kind: UazapiErrorKind | null): string | null => {
    switch (kind) {
      case 'rate_limited':
        return t('errorRateLimited', { seconds: state.retryAfterSec ?? 5 });
      case 'unavailable':
        return t('errorUnavailable');
      case 'instance_gone':
        return t('errorInstanceGone');
      case 'start_failed':
        return t('errorStartFailed');
      case 'forbidden':
        return t('errorForbidden');
      case 'hibernated':
        return t('errorHibernated');
      default:
        return null;
    }
  };

  const { phase } = state;
  const busy = phase === 'starting';
  const pairing = phase === 'waiting_qr' || phase === 'qr';
  const error = errorText(state.error);
  const pollingError =
    state.shouldPoll &&
    (state.error === 'unavailable' || state.error === 'rate_limited');

  const chip =
    phase === 'connected' ? (
      <SettingsChip variant="ok">
        <StatusDot tone="ok" />
        {t('statusConnected')}
      </SettingsChip>
    ) : pairing || busy ? (
      <SettingsChip variant="warn">{t('statusConnecting')}</SettingsChip>
    ) : (
      <SettingsChip variant="muted">
        <StatusDot tone="muted" />
        {t('statusNotConnected')}
      </SettingsChip>
    );

  return (
    <div className="space-y-6">
      {/* Permanent notice: unofficial API + what is unavailable. */}
      <Alert className="border-amber-600/40 bg-amber-500/10">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="mt-0.5 size-5 shrink-0 text-amber-500"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <AlertTitle className="text-foreground mb-1">
              {t('noticeTitle')}
            </AlertTitle>
            <AlertDescription className="text-muted-foreground space-y-1 text-sm">
              <p>{t('noticeBody')}</p>
              <p>{t('noticeUnavailable')}</p>
            </AlertDescription>
          </div>
        </div>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-foreground">{t('title')}</CardTitle>
            {chip}
          </div>
          <CardDescription className="text-muted-foreground">
            {t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status + errors, announced to assistive tech. */}
          <div aria-live="polite" className="space-y-2 text-sm">
            {error ? (
              <p
                className={
                  pollingError
                    ? 'text-amber-600 dark:text-amber-300'
                    : 'text-red-600 dark:text-red-300'
                }
              >
                {error}
              </p>
            ) : null}
            {phase === 'waiting_qr' ? (
              <p className="text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t('waitingForQr')}
              </p>
            ) : null}
            {phase === 'qr' && state.qrExpired ? (
              <p className="text-muted-foreground">{t('qrExpired')}</p>
            ) : null}
            {phase === 'idle' ? (
              <p className="text-muted-foreground">{t('notConnectedDesc')}</p>
            ) : null}
            {phase === 'connected' ? (
              <p className="text-muted-foreground">{t('connectedDesc')}</p>
            ) : null}
          </div>

          {!canEditSettings ? (
            <p className="text-muted-foreground text-xs">{t('adminOnly')}</p>
          ) : null}

          {phase === 'qr' && state.qr ? (
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <div className="border-border relative shrink-0 rounded-lg border bg-white p-3">
                {/* A data: URL from our own API — next/image adds nothing here. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={state.qr}
                  alt={t('qrAlt')}
                  width={224}
                  height={224}
                  className={
                    'size-56 ' +
                    (state.qrExpired ? 'opacity-20 blur-[2px]' : '')
                  }
                />
              </div>
              <div className="text-muted-foreground space-y-3 text-sm">
                <p>{t('scanInstructions')}</p>
                {!state.qrExpired && state.shouldPoll ? (
                  <p className="flex items-center gap-2 text-xs">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    {t('checking')}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {phase === 'connected' ? (
            <dl className="border-border bg-card/60 grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground text-xs">
                  {t('phoneLabel')}
                </dt>
                <dd className="text-foreground mt-0.5 flex items-center gap-1.5 font-medium">
                  <CheckCircle2
                    className="size-4 text-emerald-500"
                    aria-hidden
                  />
                  {state.phone
                    ? `+${state.phone.replace(/^\+/, '')}`
                    : t('unknown')}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  {t('profileLabel')}
                </dt>
                <dd className="text-foreground mt-0.5 font-medium">
                  {state.profileName ?? t('unknown')}
                </dd>
              </div>
            </dl>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {phase === 'idle' || phase === 'starting' ? (
              <Button onClick={generateQr} disabled={busy || !canEditSettings}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <QrCode className="size-4" aria-hidden />
                )}
                {busy ? t('generating') : t('generateQr')}
              </Button>
            ) : null}

            {phase === 'qr' && state.qrExpired ? (
              <Button onClick={generateQr} disabled={!canEditSettings}>
                <RefreshCw className="size-4" aria-hidden />
                {t('newQr')}
              </Button>
            ) : null}

            {pollingError ? (
              <Button variant="outline" onClick={retryNow}>
                <RefreshCw className="size-4" aria-hidden />
                {t('retryNow')}
              </Button>
            ) : null}

            {phase !== 'idle' && phase !== 'starting' ? (
              <Button
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={!canEditSettings || disconnecting}
              >
                <Unplug className="size-4" aria-hidden />
                {t('disconnect')}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!disconnecting) setConfirmOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('disconnectTitle')}</DialogTitle>
            <DialogDescription>{t('disconnectDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={disconnecting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={disconnect}
              disabled={disconnecting}
            >
              {disconnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t('disconnecting')}
                </>
              ) : (
                t('disconnect')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
