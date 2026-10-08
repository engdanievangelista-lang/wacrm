/**
 * Pure state machine behind the UAZAPI (QR code) connection panel.
 *
 * Kept free of React and fetch so it can be unit-tested in the node test
 * environment: the component dispatches the responses of
 * `POST /api/whatsapp/config`, `POST /api/whatsapp/uazapi/connect` and
 * `GET /api/whatsapp/uazapi/status` as events, and arms a single timer
 * from `nextPollMs` whenever `shouldPoll` is true and `pollSeq` changes.
 */

export type UazapiRemoteState =
  'disconnected' | 'connecting' | 'connected' | 'hibernated';

export type UazapiPhase =
  /** Nothing linked: offer "Generate QR". */
  | 'idle'
  /** Creating the instance / asking UAZAPI to start pairing. */
  | 'starting'
  /** Pairing started but no QR yet. */
  | 'waiting_qr'
  /** QR on screen (possibly expired). */
  | 'qr'
  | 'connected';

export type UazapiErrorKind =
  /** 429 — waiting Retry-After before the next poll. */
  | 'rate_limited'
  /** 5xx / network — polling continues with backoff. */
  | 'unavailable'
  /** 409 — the UAZAPI instance no longer exists. */
  | 'instance_gone'
  /** Create/connect request failed; "Generate QR" retries. */
  | 'start_failed'
  /** 401/403 — the viewer may not manage the connection. */
  | 'forbidden'
  /** The instance went to sleep; a new QR is needed. */
  | 'hibernated';

export interface UazapiUiState {
  phase: UazapiPhase;
  qr: string | null;
  /** When the QR currently shown first arrived (ms epoch). */
  qrReceivedAt: number | null;
  qrExpired: boolean;
  phone: string | null;
  profileName: string | null;
  error: UazapiErrorKind | null;
  retryAfterSec: number | null;
  consecutiveErrors: number;
  /** When the current pairing attempt began (ms epoch). */
  startedAt: number | null;
  /** False once polling must stop (connected, expired, unmount, …). */
  shouldPoll: boolean;
  /** Delay before the next status poll; null = do not poll. */
  nextPollMs: number | null;
  /** Bumped whenever a poll is scheduled so an identical delay still re-arms. */
  pollSeq: number;
}

export type UazapiEvent =
  | { type: 'start'; now: number }
  | {
      type: 'connect_ok';
      state: UazapiRemoteState;
      qr: string | null;
      now: number;
    }
  | {
      type: 'status_ok';
      state: UazapiRemoteState;
      qr: string | null;
      phone: string | null;
      profileName: string | null;
      now: number;
    }
  | {
      type: 'http_error';
      /** 'start' = config create / connect; 'poll' = status. 0 = network. */
      during: 'start' | 'poll';
      status: number;
      retryAfterSec: number | null;
      now: number;
    }
  /** Unmount or disconnect in progress: stop polling, ignore late answers. */
  | { type: 'stop' }
  /** After the connection was removed. */
  | { type: 'reset' }
  /** Poll right away ("Retry now", or resume after a failed disconnect). */
  | { type: 'retry_now' };

export const POLL_INTERVAL_MS = 3_000;
/** A QR that has not changed for this long is treated as expired. */
export const QR_TTL_MS = 60_000;
export const MAX_ERROR_BACKOFF_MS = 30_000;
/** A 'disconnected' status this soon after starting is server lag, not a failure. */
export const START_GRACE_MS = 10_000;
const MAX_RETRY_AFTER_SEC = 300;

const IDLE: UazapiUiState = {
  phase: 'idle',
  qr: null,
  qrReceivedAt: null,
  qrExpired: false,
  phone: null,
  profileName: null,
  error: null,
  retryAfterSec: null,
  consecutiveErrors: 0,
  startedAt: null,
  shouldPoll: false,
  nextPollMs: null,
  pollSeq: 0,
};

/** Initial state from the locally mirrored row (`GET /api/whatsapp/config`). */
export function initialUazapiState(
  config: {
    status: string | null;
    phone: string | null;
    profileName: string | null;
  } | null,
  opts: { now?: number; canPoll?: boolean } = {}
): UazapiUiState {
  if (!config) return IDLE;
  if (config.status === 'connected') {
    return {
      ...IDLE,
      phase: 'connected',
      phone: config.phone,
      profileName: config.profileName,
    };
  }
  if (config.status === 'connecting' && opts.canPoll !== false) {
    // Pairing was left half-way (page reload): ask status for the QR now.
    return {
      ...IDLE,
      phase: 'waiting_qr',
      startedAt: opts.now ?? null,
      shouldPoll: true,
      nextPollMs: 0,
      pollSeq: 1,
    };
  }
  return IDLE;
}

function schedule(s: UazapiUiState, delayMs: number): UazapiUiState {
  return {
    ...s,
    shouldPoll: true,
    nextPollMs: delayMs,
    pollSeq: s.pollSeq + 1,
  };
}

function stopped(s: UazapiUiState): UazapiUiState {
  return { ...s, shouldPoll: false, nextPollMs: null };
}

function backToIdle(
  s: UazapiUiState,
  error: UazapiErrorKind | null
): UazapiUiState {
  return { ...IDLE, error, pollSeq: s.pollSeq };
}

/** Apply a 'connecting' answer carrying (or not) a QR. */
function applyConnecting(
  s: UazapiUiState,
  qr: string | null,
  now: number
): UazapiUiState {
  const base: UazapiUiState = {
    ...s,
    error: null,
    retryAfterSec: null,
    consecutiveErrors: 0,
  };
  if (!qr) {
    return schedule(
      {
        ...base,
        phase: 'waiting_qr',
        qr: null,
        qrReceivedAt: null,
        qrExpired: false,
      },
      POLL_INTERVAL_MS
    );
  }
  const sameQr = s.qr === qr && s.qrReceivedAt !== null;
  const qrReceivedAt = sameQr ? (s.qrReceivedAt as number) : now;
  const next: UazapiUiState = {
    ...base,
    phase: 'qr',
    qr,
    qrReceivedAt,
    qrExpired: false,
  };
  if (now - qrReceivedAt >= QR_TTL_MS) {
    return stopped({ ...next, qrExpired: true });
  }
  return schedule(next, POLL_INTERVAL_MS);
}

function errorBackoffMs(consecutiveErrors: number): number {
  return Math.min(
    POLL_INTERVAL_MS * 2 ** consecutiveErrors,
    MAX_ERROR_BACKOFF_MS
  );
}

export function uazapiReducer(s: UazapiUiState, e: UazapiEvent): UazapiUiState {
  switch (e.type) {
    case 'start':
      return {
        ...IDLE,
        phase: 'starting',
        startedAt: e.now,
        pollSeq: s.pollSeq,
      };

    case 'stop':
      return stopped(s);

    case 'reset':
      return backToIdle(s, null);

    case 'retry_now': {
      const pairing =
        s.phase === 'waiting_qr' || (s.phase === 'qr' && !s.qrExpired);
      return pairing ? schedule(s, 0) : s;
    }

    case 'connect_ok':
      if (s.phase !== 'starting') return s;
      if (e.state === 'connected') {
        return stopped({ ...s, phase: 'connected', qr: null });
      }
      // Anything else: the status route is the authoritative QR source.
      return applyConnecting(s, e.qr, e.now);

    case 'status_ok': {
      if (!s.shouldPoll) return s;
      if (e.state === 'connected') {
        return stopped({
          ...s,
          phase: 'connected',
          qr: null,
          qrReceivedAt: null,
          qrExpired: false,
          phone: e.phone,
          profileName: e.profileName,
          error: null,
          retryAfterSec: null,
          consecutiveErrors: 0,
        });
      }
      if (e.state === 'connecting') return applyConnecting(s, e.qr, e.now);
      // 'disconnected' / 'hibernated'.
      const inGrace =
        e.state === 'disconnected' &&
        s.startedAt !== null &&
        e.now - s.startedAt < START_GRACE_MS;
      if (inGrace) return schedule(s, POLL_INTERVAL_MS);
      return backToIdle(s, e.state === 'hibernated' ? 'hibernated' : null);
    }

    case 'http_error': {
      if (e.during === 'start') {
        if (s.phase !== 'starting') return s;
        if (e.status === 409) return backToIdle(s, 'instance_gone');
        if (e.status === 401 || e.status === 403) {
          return backToIdle(s, 'forbidden');
        }
        if (e.status === 429) {
          return {
            ...backToIdle(s, 'rate_limited'),
            retryAfterSec: e.retryAfterSec,
          };
        }
        return backToIdle(s, 'start_failed');
      }

      if (!s.shouldPoll) return s;
      if (e.status === 409) return backToIdle(s, 'instance_gone');
      if (e.status === 401 || e.status === 403) {
        return backToIdle(s, 'forbidden');
      }
      // 400: there is no UAZAPI config any more (removed elsewhere).
      if (e.status === 400) return backToIdle(s, null);
      if (e.status === 429) {
        const waitMs = Math.max(
          (e.retryAfterSec ?? 0) * 1000,
          POLL_INTERVAL_MS
        );
        return schedule(
          { ...s, error: 'rate_limited', retryAfterSec: e.retryAfterSec },
          waitMs
        );
      }
      // 5xx or network: keep what is on screen, retry gently.
      const consecutiveErrors = s.consecutiveErrors + 1;
      return schedule(
        {
          ...s,
          error: 'unavailable',
          retryAfterSec: null,
          consecutiveErrors,
        },
        errorBackoffMs(consecutiveErrors)
      );
    }
  }
}

/** Retry-After (seconds) from the header, else the body's `retry_after_seconds`. */
export function parseRetryAfter(
  header: string | null,
  body: unknown
): number | null {
  const fromHeader = header !== null ? Number(header.trim()) : NaN;
  const fromBody =
    body && typeof body === 'object'
      ? Number((body as { retry_after_seconds?: unknown }).retry_after_seconds)
      : NaN;
  const value =
    Number.isFinite(fromHeader) && header?.trim() ? fromHeader : fromBody;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.ceil(value), MAX_RETRY_AFTER_SEC);
}

export type WhatsAppProvider = 'meta' | 'uazapi';

/**
 * Whether switching the panel to `target` must first remove the saved
 * config (DELETE /api/whatsapp/config):
 *  - a working Meta connection would otherwise be silently replaced;
 *  - any UAZAPI row blocks a Meta save server-side ("disconnect first").
 * A broken Meta row is replaced in place by the UAZAPI create.
 */
export function switchNeedsDisconnect(
  current: {
    provider: WhatsAppProvider | null;
    connected?: boolean;
    status?: string | null;
  },
  target: WhatsAppProvider
): boolean {
  if (!current.provider || current.provider === target) return false;
  if (current.provider === 'uazapi') return true;
  return current.connected === true;
}
