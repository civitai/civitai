import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks shared between vi.mock factories and the test bodies.
const { mockLogToAxiom, mockWithSignals } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  mockWithSignals: vi.fn(),
}));

vi.mock('~/env/server', () => ({
  env: {
    SIGNALS_ENDPOINT: 'http://signals.test',
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  safeError: (e: unknown) =>
    e instanceof Error ? { name: e.name, message: e.message } : e == null ? undefined : { message: String(e) },
}));

// SignalsCallTimeoutError must be the REAL class so `instanceof` in the service
// matches; withSignals is mocked so the test drives the fetch outcome directly
// without exercising the circuit breaker.
vi.mock('~/server/signals/wrapper', async () => {
  class SignalsCallTimeoutError extends Error {
    readonly code = 'SIGNALS_CALL_TIMEOUT';
    readonly reason: 'timeout' | 'concurrency';
    constructor(reason: 'timeout' | 'concurrency', message?: string) {
      super(message ?? reason);
      this.name = 'SignalsCallTimeoutError';
      this.reason = reason;
    }
  }
  return { SignalsCallTimeoutError, withSignals: mockWithSignals };
});

vi.mock('~/server/utils/errorHandling', () => ({
  throwBadRequestError: () => {
    throw new Error('BAD_REQUEST');
  },
}));

import { getAccessToken } from '~/server/services/signals.service';
import { SignalsCallTimeoutError } from '~/server/signals/wrapper';

describe('signals.service getAccessToken', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    // Default: withSignals just runs the wrapped fn (i.e. the fetch).
    mockWithSignals.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the token on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'tok_123' }),
    });

    const result = await getAccessToken({ id: 42 });

    expect(result).toEqual({ accessToken: 'tok_123' });
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('fails SOFT (degraded, no token) when the signals fetch rejects with "fetch failed"', async () => {
    // The exact production symptom: undici TypeError, cause "fetch failed".
    const err = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(err);

    const result = await getAccessToken({ id: 42 });

    // Degraded result the client tolerates — NOT a throw / 500.
    expect(result).toEqual({});
    expect(result.accessToken).toBeUndefined();

    // Still observable to ops.
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    const payload = mockLogToAxiom.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'signals-fail-soft',
      type: 'warning',
      reason: 'fetch-failed',
      fn: 'getAccessToken',
      userId: 42,
    });
  });

  it('fails SOFT when the circuit is open / call times out (SignalsCallTimeoutError)', async () => {
    mockWithSignals.mockRejectedValue(new SignalsCallTimeoutError('timeout'));

    const result = await getAccessToken({ id: 7 });

    expect(result).toEqual({});
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({
      name: 'signals-fail-soft',
      reason: 'circuit-timeout',
    });
  });

  it('fails SOFT on a non-OK (non-400) signals response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const result = await getAccessToken({ id: 9 });

    expect(result).toEqual({});
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({
      name: 'signals-fail-soft',
      reason: 'non-ok-response',
      status: 503,
    });
  });

  it('still throws on a 400 (real bad request, not a transient outage)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    await expect(getAccessToken({ id: 9 })).rejects.toThrow('BAD_REQUEST');
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });
});

// `_app` SSR-seeds `signals.getToken` by calling this SAME `getAccessToken`
// function server-side, so the seeded `initialData` is byte-identical to the
// tRPC resolver output by construction (the resolver also just calls it). These
// tests pin the two shapes the SSR seed relies on:
//  - a SUCCESS seed carries `accessToken` → AppProvider's `enabled:
//    !!signalsToken?.accessToken` primes the worker query and suppresses the
//    bootstrap fetch; the worker opens the connection from the seed.
//  - a DEGRADED seed is `{}` (no `accessToken`) → the seed gate is false, the
//    worker falls back to its own query (which re-degrades to `{}`), and
//    `useSignalsWorker` reads `data?.accessToken` as undefined → no connection,
//    exactly as today. No 500 reaches the SSR render path.
describe('signals.service getAccessToken (signals.getToken SSR-seed shapes)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mockWithSignals.mockImplementation((fn: () => Promise<unknown>) => fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('success seed exposes a truthy accessToken (primes the worker query)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'tok_seed' }),
    });
    const seed = await getAccessToken({ id: 1 });
    // The exact gate AppProvider uses to decide whether to seed.
    expect(!!seed.accessToken).toBe(true);
    expect(seed).toEqual({ accessToken: 'tok_seed' });
  });

  it('degraded seed is {} with no accessToken (worker self-heals, no connection)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const seed = await getAccessToken({ id: 1 });
    expect(!!seed.accessToken).toBe(false);
    expect(seed).toEqual({});
  });
});
