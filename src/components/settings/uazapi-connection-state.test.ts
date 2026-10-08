import { describe, expect, it } from 'vitest';

import {
  POLL_INTERVAL_MS,
  QR_TTL_MS,
  MAX_ERROR_BACKOFF_MS,
  START_GRACE_MS,
  initialUazapiState,
  parseRetryAfter,
  switchNeedsDisconnect,
  decideProviderSwitch,
  shouldUseProviderPanel,
  uazapiReducer,
  type UazapiUiState,
} from './uazapi-connection-state';

const T0 = 1_000_000;
const QR_A = 'data:image/png;base64,AAAA';
const QR_B = 'data:image/png;base64,BBBB';

/** Drive the reducer from idle through a successful start showing QR_A. */
function showingQr(now = T0): UazapiUiState {
  let s = initialUazapiState(null);
  s = uazapiReducer(s, { type: 'start', now });
  return uazapiReducer(s, {
    type: 'connect_ok',
    state: 'connecting',
    qr: QR_A,
    now,
  });
}

describe('initialUazapiState', () => {
  it('starts idle with no polling when nothing is saved', () => {
    const s = initialUazapiState(null);
    expect(s.phase).toBe('idle');
    expect(s.shouldPoll).toBe(false);
    expect(s.nextPollMs).toBeNull();
  });

  it('shows a connected row as connected without polling', () => {
    const s = initialUazapiState({
      status: 'connected',
      phone: '5511999990000',
      profileName: 'Shop',
    });
    expect(s.phase).toBe('connected');
    expect(s.phone).toBe('5511999990000');
    expect(s.profileName).toBe('Shop');
    expect(s.shouldPoll).toBe(false);
  });

  it('resumes polling for a connecting row (waiting for the QR)', () => {
    const s = initialUazapiState(
      { status: 'connecting', phone: null, profileName: null },
      { now: T0 }
    );
    expect(s.phase).toBe('waiting_qr');
    expect(s.shouldPoll).toBe(true);
    expect(s.nextPollMs).toBe(0);
  });

  it('does not poll a connecting row when the viewer cannot manage it', () => {
    const s = initialUazapiState(
      { status: 'connecting', phone: null, profileName: null },
      { now: T0, canPoll: false }
    );
    expect(s.shouldPoll).toBe(false);
  });
});

describe('start / connect', () => {
  it('start clears errors and does not poll yet', () => {
    let s = initialUazapiState(null);
    s = { ...s, error: 'instance_gone' };
    s = uazapiReducer(s, { type: 'start', now: T0 });
    expect(s.phase).toBe('starting');
    expect(s.error).toBeNull();
    expect(s.shouldPoll).toBe(false);
  });

  it('a connect response with a QR shows it and polls every ~3 s', () => {
    const s = showingQr();
    expect(s.phase).toBe('qr');
    expect(s.qr).toBe(QR_A);
    expect(s.qrReceivedAt).toBe(T0);
    expect(s.qrExpired).toBe(false);
    expect(s.shouldPoll).toBe(true);
    expect(s.nextPollMs).toBe(POLL_INTERVAL_MS);
  });

  it('a connect response with a null QR waits for it and keeps polling', () => {
    let s = uazapiReducer(initialUazapiState(null), { type: 'start', now: T0 });
    s = uazapiReducer(s, {
      type: 'connect_ok',
      state: 'connecting',
      qr: null,
      now: T0,
    });
    expect(s.phase).toBe('waiting_qr');
    expect(s.shouldPoll).toBe(true);
    expect(s.nextPollMs).toBe(POLL_INTERVAL_MS);
  });

  it('a start failure returns to idle with a retryable error and no polling', () => {
    let s = uazapiReducer(initialUazapiState(null), { type: 'start', now: T0 });
    s = uazapiReducer(s, {
      type: 'http_error',
      during: 'start',
      status: 502,
      retryAfterSec: null,
      now: T0,
    });
    expect(s.phase).toBe('idle');
    expect(s.error).toBe('start_failed');
    expect(s.shouldPoll).toBe(false);
  });

  it('a 409 on connect means the instance is gone', () => {
    let s = uazapiReducer(initialUazapiState(null), { type: 'start', now: T0 });
    s = uazapiReducer(s, {
      type: 'http_error',
      during: 'start',
      status: 409,
      retryAfterSec: null,
      now: T0,
    });
    expect(s.phase).toBe('idle');
    expect(s.error).toBe('instance_gone');
    expect(s.shouldPoll).toBe(false);
  });
});

describe('status polling', () => {
  it('stops polling once connected and keeps number + profile', () => {
    let s = showingQr();
    s = uazapiReducer(s, {
      type: 'status_ok',
      state: 'connected',
      qr: null,
      phone: '5511999990000',
      profileName: 'Shop',
      now: T0 + 3000,
    });
    expect(s.phase).toBe('connected');
    expect(s.phone).toBe('5511999990000');
    expect(s.profileName).toBe('Shop');
    expect(s.qr).toBeNull();
    expect(s.shouldPoll).toBe(false);
    expect(s.nextPollMs).toBeNull();
  });

  it('stop (unmount / disconnect) turns polling off and ignores late responses', () => {
    let s = showingQr();
    s = uazapiReducer(s, { type: 'stop' });
    expect(s.shouldPoll).toBe(false);
    expect(s.nextPollMs).toBeNull();

    const late = uazapiReducer(s, {
      type: 'status_ok',
      state: 'connecting',
      qr: QR_B,
      phone: null,
      profileName: null,
      now: T0 + 3000,
    });
    expect(late).toBe(s);
    const lateErr = uazapiReducer(s, {
      type: 'http_error',
      during: 'poll',
      status: 502,
      retryAfterSec: null,
      now: T0 + 3000,
    });
    expect(lateErr).toBe(s);
  });

  it('retry_now re-arms an immediate poll while pairing (e.g. after a failed disconnect)', () => {
    let s = uazapiReducer(showingQr(), { type: 'stop' });
    s = uazapiReducer(s, { type: 'retry_now' });
    expect(s.shouldPoll).toBe(true);
    expect(s.nextPollMs).toBe(0);
  });

  it('retry_now does nothing when there is nothing to poll for', () => {
    const idle = initialUazapiState(null);
    expect(uazapiReducer(idle, { type: 'retry_now' })).toBe(idle);

    const connected = uazapiReducer(showingQr(), {
      type: 'status_ok',
      state: 'connected',
      qr: null,
      phone: '1',
      profileName: null,
      now: T0,
    });
    expect(uazapiReducer(connected, { type: 'retry_now' })).toBe(connected);

    const expired = uazapiReducer(showingQr(), {
      type: 'status_ok',
      state: 'connecting',
      qr: QR_A,
      phone: null,
      profileName: null,
      now: T0 + QR_TTL_MS,
    });
    expect(uazapiReducer(expired, { type: 'retry_now' })).toBe(expired);
  });

  it('reset after a disconnect returns to idle without polling', () => {
    let s = uazapiReducer(showingQr(), {
      type: 'status_ok',
      state: 'connected',
      qr: null,
      phone: '1',
      profileName: 'x',
      now: T0,
    });
    s = uazapiReducer(s, { type: 'reset' });
    expect(s.phase).toBe('idle');
    expect(s.phone).toBeNull();
    expect(s.shouldPoll).toBe(false);
  });

  it('every scheduled poll bumps pollSeq so the timer re-arms', () => {
    const s1 = showingQr();
    const s2 = uazapiReducer(s1, {
      type: 'status_ok',
      state: 'connecting',
      qr: QR_A,
      phone: null,
      profileName: null,
      now: T0 + 3000,
    });
    expect(s2.pollSeq).toBeGreaterThan(s1.pollSeq);
  });

  it('connecting with a null QR keeps polling and shows waiting for QR', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'status_ok',
      state: 'connecting',
      qr: null,
      phone: null,
      profileName: null,
      now: T0 + 3000,
    });
    expect(s.phase).toBe('waiting_qr');
    expect(s.shouldPoll).toBe(true);
    expect(s.nextPollMs).toBe(POLL_INTERVAL_MS);
  });

  it('an unchanged QR keeps its expiry timer; a new QR resets it', () => {
    let s = showingQr();
    s = uazapiReducer(s, {
      type: 'status_ok',
      state: 'connecting',
      qr: QR_A,
      phone: null,
      profileName: null,
      now: T0 + 20_000,
    });
    expect(s.qrReceivedAt).toBe(T0);

    s = uazapiReducer(s, {
      type: 'status_ok',
      state: 'connecting',
      qr: QR_B,
      phone: null,
      profileName: null,
      now: T0 + 40_000,
    });
    expect(s.qr).toBe(QR_B);
    expect(s.qrReceivedAt).toBe(T0 + 40_000);
    expect(s.qrExpired).toBe(false);
  });

  it('a QR unchanged past its TTL is expired: polling stops and regenerate is offered', () => {
    let s = showingQr();
    s = uazapiReducer(s, {
      type: 'status_ok',
      state: 'connecting',
      qr: QR_A,
      phone: null,
      profileName: null,
      now: T0 + QR_TTL_MS,
    });
    expect(s.phase).toBe('qr');
    expect(s.qrExpired).toBe(true);
    expect(s.shouldPoll).toBe(false);

    // "Generate new QR" is just another start.
    s = uazapiReducer(s, { type: 'start', now: T0 + QR_TTL_MS + 1 });
    expect(s.phase).toBe('starting');
    expect(s.qrExpired).toBe(false);
  });

  it('a disconnected status returns to not-connected and stops polling', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'status_ok',
      state: 'disconnected',
      qr: null,
      phone: null,
      profileName: null,
      now: T0 + START_GRACE_MS + 1,
    });
    expect(s.phase).toBe('idle');
    expect(s.qr).toBeNull();
    expect(s.shouldPoll).toBe(false);
  });

  it('tolerates a disconnected status right after start (server lag)', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'status_ok',
      state: 'disconnected',
      qr: null,
      phone: null,
      profileName: null,
      now: T0 + 1000,
    });
    expect(s.phase).not.toBe('idle');
    expect(s.shouldPoll).toBe(true);
  });

  it('a hibernated status returns to not-connected with a notice', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'status_ok',
      state: 'hibernated',
      qr: null,
      phone: null,
      profileName: null,
      now: T0 + START_GRACE_MS + 1,
    });
    expect(s.phase).toBe('idle');
    expect(s.error).toBe('hibernated');
    expect(s.shouldPoll).toBe(false);
  });

  it('a 409 while polling returns to not-connected (instance gone)', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'http_error',
      during: 'poll',
      status: 409,
      retryAfterSec: null,
      now: T0 + 3000,
    });
    expect(s.phase).toBe('idle');
    expect(s.error).toBe('instance_gone');
    expect(s.shouldPoll).toBe(false);
  });

  it('a 429 waits Retry-After before the next poll and keeps the QR', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'http_error',
      during: 'poll',
      status: 429,
      retryAfterSec: 12,
      now: T0 + 3000,
    });
    expect(s.phase).toBe('qr');
    expect(s.qr).toBe(QR_A);
    expect(s.error).toBe('rate_limited');
    expect(s.retryAfterSec).toBe(12);
    expect(s.shouldPoll).toBe(true);
    expect(s.nextPollMs).toBe(12_000);
  });

  it('a 429 without Retry-After still waits at least the normal interval', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'http_error',
      during: 'poll',
      status: 429,
      retryAfterSec: null,
      now: T0 + 3000,
    });
    expect(s.nextPollMs).toBeGreaterThanOrEqual(POLL_INTERVAL_MS);
  });

  it('a 502 is a retryable error: keeps polling with a gentle, capped backoff', () => {
    let s = showingQr();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      s = uazapiReducer(s, {
        type: 'http_error',
        during: 'poll',
        status: 502,
        retryAfterSec: null,
        now: T0 + 3000,
      });
      expect(s.error).toBe('unavailable');
      expect(s.shouldPoll).toBe(true);
      delays.push(s.nextPollMs!);
    }
    expect(delays[0]).toBeGreaterThan(POLL_INTERVAL_MS);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(Math.max(...delays)).toBe(MAX_ERROR_BACKOFF_MS);
    expect(s.qr).toBe(QR_A);

    // The next good answer clears the error and restores the normal pace.
    s = uazapiReducer(s, {
      type: 'status_ok',
      state: 'connecting',
      qr: QR_A,
      phone: null,
      profileName: null,
      now: T0 + 6000,
    });
    expect(s.error).toBeNull();
    expect(s.consecutiveErrors).toBe(0);
    expect(s.nextPollMs).toBe(POLL_INTERVAL_MS);
  });

  it('a network failure (status 0) is treated like a 502', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'http_error',
      during: 'poll',
      status: 0,
      retryAfterSec: null,
      now: T0 + 3000,
    });
    expect(s.error).toBe('unavailable');
    expect(s.shouldPoll).toBe(true);
  });

  it('403 while polling stops with a forbidden error', () => {
    const s = uazapiReducer(showingQr(), {
      type: 'http_error',
      during: 'poll',
      status: 403,
      retryAfterSec: null,
      now: T0 + 3000,
    });
    expect(s.error).toBe('forbidden');
    expect(s.shouldPoll).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('reads the header in seconds', () => {
    expect(parseRetryAfter('7', null)).toBe(7);
  });
  it('falls back to the body retry_after_seconds', () => {
    expect(parseRetryAfter(null, { retry_after_seconds: 9 })).toBe(9);
  });
  it('returns null for junk', () => {
    expect(parseRetryAfter('soon', { retry_after_seconds: 'x' })).toBeNull();
    expect(parseRetryAfter(null, null)).toBeNull();
  });
  it('caps absurd values', () => {
    expect(parseRetryAfter('99999', null)).toBeLessThanOrEqual(300);
  });
});

describe('switchNeedsDisconnect', () => {
  it('no saved config: switch freely', () => {
    expect(switchNeedsDisconnect({ provider: null }, 'uazapi')).toBe(false);
    expect(switchNeedsDisconnect({ provider: null }, 'meta')).toBe(false);
  });
  it('same provider: nothing to do', () => {
    expect(
      switchNeedsDisconnect({ provider: 'meta', connected: true }, 'meta')
    ).toBe(false);
  });
  it('connected Meta -> UAZAPI needs a disconnect', () => {
    expect(
      switchNeedsDisconnect({ provider: 'meta', connected: true }, 'uazapi')
    ).toBe(true);
  });
  it('broken Meta row -> UAZAPI is replaced in place by the server', () => {
    expect(
      switchNeedsDisconnect({ provider: 'meta', connected: false }, 'uazapi')
    ).toBe(false);
  });
  it('any UAZAPI row -> Meta needs a disconnect (the Meta save refuses otherwise)', () => {
    for (const status of ['connected', 'connecting', 'disconnected']) {
      expect(
        switchNeedsDisconnect({ provider: 'uazapi', status }, 'meta')
      ).toBe(true);
    }
  });
});

describe('create-step 400 (existing connection)', () => {
  it('a 400 from the config create says an existing connection must go first', () => {
    let s = uazapiReducer(initialUazapiState(null), { type: 'start', now: T0 });
    s = uazapiReducer(s, {
      type: 'http_error',
      during: 'start',
      request: 'create',
      status: 400,
      retryAfterSec: null,
      now: T0,
    });
    expect(s.phase).toBe('idle');
    expect(s.error).toBe('existing_connection');
    expect(s.shouldPoll).toBe(false);
  });

  it('a 400 from connect stays the generic start failure', () => {
    let s = uazapiReducer(initialUazapiState(null), { type: 'start', now: T0 });
    s = uazapiReducer(s, {
      type: 'http_error',
      during: 'start',
      request: 'connect',
      status: 400,
      retryAfterSec: null,
      now: T0,
    });
    expect(s.error).toBe('start_failed');
  });
});

describe('decideProviderSwitch', () => {
  const metaConnected = {
    provider: 'meta' as const,
    connected: true,
    status: null,
  };
  const nothing = { provider: null, connected: false, status: null };

  it('same target: nothing to do', () => {
    expect(
      decideProviderSwitch({
        selected: 'meta',
        target: 'meta',
        cached: nothing,
        fresh: nothing,
      })
    ).toBe('none');
  });

  it('uses the fresh config over a stale cache (Meta saved in this session)', () => {
    expect(
      decideProviderSwitch({
        selected: 'meta',
        target: 'uazapi',
        cached: nothing,
        fresh: metaConnected,
      })
    ).toBe('confirm');
  });

  it('a fresh "nothing saved" wins over a stale cached connection', () => {
    expect(
      decideProviderSwitch({
        selected: 'meta',
        target: 'uazapi',
        cached: metaConnected,
        fresh: nothing,
      })
    ).toBe('switch');
  });

  it('falls back to the cached config when the re-fetch failed', () => {
    expect(
      decideProviderSwitch({
        selected: 'meta',
        target: 'uazapi',
        cached: metaConnected,
        fresh: null,
      })
    ).toBe('confirm');
    expect(
      decideProviderSwitch({
        selected: 'meta',
        target: 'uazapi',
        cached: nothing,
        fresh: null,
      })
    ).toBe('switch');
  });

  it('any UAZAPI row needs a confirm to go to Meta', () => {
    expect(
      decideProviderSwitch({
        selected: 'uazapi',
        target: 'meta',
        cached: nothing,
        fresh: { provider: 'uazapi', connected: false, status: 'disconnected' },
      })
    ).toBe('confirm');
  });
});

describe('shouldUseProviderPanel', () => {
  it('Meta-only deployment with no UAZAPI row: plain Meta form', () => {
    expect(
      shouldUseProviderPanel({ uazapiEnabled: false, rowProvider: null })
    ).toBe(false);
    expect(
      shouldUseProviderPanel({ uazapiEnabled: false, rowProvider: 'meta' })
    ).toBe(false);
  });

  it('UAZAPI enabled: provider panel', () => {
    expect(
      shouldUseProviderPanel({ uazapiEnabled: true, rowProvider: null })
    ).toBe(true);
    expect(
      shouldUseProviderPanel({ uazapiEnabled: true, rowProvider: 'meta' })
    ).toBe(true);
  });

  it('env removed but the account is stranded on UAZAPI: provider panel so it can disconnect', () => {
    expect(
      shouldUseProviderPanel({ uazapiEnabled: false, rowProvider: 'uazapi' })
    ).toBe(true);
  });
});
