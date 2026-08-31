import { describe, it, expect, vi, beforeEach } from 'vitest';
// The REAL key constants. `~/server/redis/client` is mocked below; the PACKAGE it
// re-exports is not, so importing from it here gives the values production uses and the
// assertions below cannot drift away from them again.
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis/client';

/**
 * Tests for the fail-open wrapper added in PR #2332 round-3 audit on
 * `updateSessionState` (the internal helper called by `refreshSession`
 * and `invalidateSession`).
 *
 * The wrapper catches any thrown error from the atomic
 * `hSetMultiWithTTL` helper — sysRedis EVAL failures during a sentinel
 * failover (Phase 4) used to bubble up into the next-auth callback
 * chain and 500 the user-facing request. We now log via
 * `logSysRedisFailOpen` and continue.
 *
 * What we assert here is *boundary behavior*, not the Lua wiring (that
 * lives in src/server/redis/__tests__/atomic.test.ts):
 *   - happy path: helper called once, no fail-open logged, no throw.
 *   - sad path:   helper throws, fail-open is logged with the right
 *                 subtype + fn + context, the outer function does not
 *                 throw.
 *   - empty path: when there are no tokens, neither the helper nor the
 *                 fail-open logger is touched.
 */

const {
  mockHSetMultiWithTTL,
  mockLogSysRedisFailOpen,
  mockHScanNoValues,
  mockWithSysReadDeadline,
} = vi.hoisted(() => ({
  mockHSetMultiWithTTL: vi.fn(),
  mockLogSysRedisFailOpen: vi.fn(),
  mockHScanNoValues: vi.fn(),
  // STEP-4 soft-dependency: the hGetAll read is now wrapped in
  // withSysReadDeadline so a SLOW/half-open sysRedis rejects (deadline)
  // instead of parking ~11min. Transparent by default (returns the wrapped
  // promise) — override per-test to reject to model the SLOW path.
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
}));

vi.mock('~/server/redis/atomic', () => ({
  hSetMultiWithTTL: mockHSetMultiWithTTL,
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: mockLogSysRedisFailOpen,
}));

// 🔴 Spread the REAL package for the key constants rather than re-typing them. The
// hand-typed copies here were wrong in four places at once — USER_TOKENS
// 'session:user-tokens' vs the real 'session:user-tokens2', USER.SESSION 'user:session' vs
// 'session:data2', TOKEN_STATE and ALL both prefixed 'sys:' where production has no such
// prefix — so this suite asserted against keys Redis never sees and could not have caught a
// key-name regression. Client and control surface stay overridden.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  sysRedis: {
    hScanNoValues: mockHScanNoValues,
    set: vi.fn().mockResolvedValue('OK'),
  },
  withSysReadDeadline: mockWithSysReadDeadline,
}));

vi.mock('~/server/utils/cache-helpers', () => ({
  clearCacheByPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/utils/logging', () => ({
  createLogger: () => vi.fn(),
}));

vi.mock('../session-cache', () => ({
  clearSessionCache: vi.fn().mockResolvedValue(undefined),
}));

// Override the global setup mock of `session-invalidation` (setup.ts mocks
// it for OTHER tests so they don't trip the next-auth chain). We need the
// real module here.
vi.unmock('~/server/auth/session-invalidation');

// Real module under test — imported AFTER the mocks are wired.
import { refreshSession, invalidateSession } from '../session-invalidation';

/** One-page HSCAN NOVALUES reply — cursor '0' means the scan is complete. */
const onePage = (fields: string[]) => ({ cursor: '0', fields });

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  // Default: user has 2 tokens in the hash.
  mockHScanNoValues.mockResolvedValue(onePage(['token-a', 'token-b']));
});

describe('updateSessionState fail-open wrapper (via refreshSession)', () => {
  it('happy path: calls hSetMultiWithTTL once with the expected TTL and does not log fail-open', async () => {
    mockHSetMultiWithTTL.mockResolvedValue(undefined);

    await refreshSession(42, { sendSignal: false });

    expect(mockHSetMultiWithTTL).toHaveBeenCalledTimes(1);
    const [, key, fieldsObj, ttlMs] = mockHSetMultiWithTTL.mock.calls[0];
    expect(key).toBe(REDIS_SYS_KEYS.SESSION.TOKEN_STATE);
    expect(fieldsObj).toEqual({ 'token-a': 'refresh', 'token-b': 'refresh' });
    // 30 days in ms
    expect(ttlMs).toBe(60 * 60 * 24 * 30 * 1000);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('swallows EVAL throws and logs sysredis-fail-open with the right context', async () => {
    const synthetic = new Error("READONLY You can't write against a read only replica.");
    mockHSetMultiWithTTL.mockRejectedValueOnce(synthetic);

    // Must NOT throw — this is the property the PR #2332 audit asked for.
    await expect(refreshSession(42, { sendSignal: false })).resolves.toBeUndefined();

    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn, err, extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('write-degraded');
    expect(fn).toBe('session-invalidation.updateSessionState');
    expect(err).toBe(synthetic);
    expect(extra).toMatchObject({
      userId: 42,
      type: 'refresh',
      tokenCount: 2,
    });
  });

  it('skips both the helper and the fail-open logger when the user has zero tokens', async () => {
    mockHScanNoValues.mockResolvedValue(onePage([]));

    await refreshSession(42, { sendSignal: false });

    expect(mockHSetMultiWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });
});

describe('updateSessionState READ fail-open wrapper (STEP-4)', () => {
  it('happy path: scans field names through withSysReadDeadline and does not log fail-open', async () => {
    mockHSetMultiWithTTL.mockResolvedValue(undefined);

    await refreshSession(7, { sendSignal: false });

    // The read is deadline-wrapped even on the happy path.
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockHScanNoValues).toHaveBeenCalledTimes(1);
    // Tokens resolved → the write ran with them.
    expect(mockHSetMultiWithTTL).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: the scan throws → fails open to an empty list, does not throw, skips the write, logs read-degraded', async () => {
    mockHScanNoValues.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // Must NOT throw (would otherwise 500 the logout/ban request).
    await expect(invalidateSession(99)).resolves.toBeUndefined();

    // Empty token hash → no write attempted.
    expect(mockHSetMultiWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn, , extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('read-degraded');
    expect(fn).toBe('session-invalidation.updateSessionState read');
    expect(extra).toMatchObject({ userId: 99, type: 'invalid' });
  });

  it('SLOW/half-open: the scan NEVER settles + deadline REJECTS → fails open (fail-on-revert: a bare await would hang and time out)', async () => {
    // Model a SLOW/half-open sysRedis: the scan never settles (would park
    // ~11min in prod), so ONLY the withSysReadDeadline race can unblock the
    // caller. This PINS the wrap — remove `withSysReadDeadline(...)` and the
    // bare `await sysRedis.hScanNoValues` hangs forever → this test TIMES OUT.
    // A resolved mock would pass even without the wrap.
    mockHScanNoValues.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    await expect(refreshSession(123, { sendSignal: false })).resolves.toBeUndefined();

    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockHSetMultiWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][3]).toMatchObject({
      userId: 123,
      type: 'refresh',
    });
  });
});

describe('updateSessionState token-map build is linear', () => {
  /**
   * The map was built with `tokens.reduce((acc, t) => ({ ...acc, [t]: type }), {})`,
   * which shallow-copies the accumulator every iteration: O(n^2) property copies,
   * synchronous, with no yield point.
   *
   * Scope: this covers the in-process map build only — `hSetMultiWithTTL` is
   * mocked here, so a pass says nothing about whether a hash this size can be
   * written. The budget is deliberately loose (measured: 5.6ms linear vs 21138ms
   * quadratic at this n), so a slow machine cannot flip it. n is capped at 10k
   * because the quadratic form blocks the loop, so vitest's timeout cannot fire
   * until it finishes — a revert must fail on the assertion rather than wedge
   * the runner.
   */
  it('builds the token map in linear time', async () => {
    const tokenCount = 10_000;
    const allFields = Array.from({ length: tokenCount }, (_, i) => `token-${i}`);
    mockHScanNoValues.mockResolvedValue(onePage(allFields));
    mockHSetMultiWithTTL.mockResolvedValue(undefined);

    const startedAt = performance.now();
    await refreshSession(42, { sendSignal: false });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);

    const [, , fieldsObj] = mockHSetMultiWithTTL.mock.calls[0];
    expect(fieldsObj['token-0']).toBe('refresh');
    expect(fieldsObj[`token-${tokenCount - 1}`]).toBe('refresh');
  });
});

describe('updateSessionState fail-open wrapper (via invalidateSession)', () => {
  it('does NOT throw on sysRedis failure (security contract was updated in PR #2332)', async () => {
    mockHSetMultiWithTTL.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // The previous contract was "throws on sysRedis unreachable"; the
    // round-3 audit moved this path to fail-open. The read side is
    // already fail-open (token-refresh.ts), so a missed write is
    // symmetric — see updated docstring on invalidateSession.
    await expect(invalidateSession(42)).resolves.toBeUndefined();

    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][3]).toMatchObject({ type: 'invalid' });
  });
});

// The read only ever needed field NAMES — the previous hGetAll pulled every value across the wire and threw
// them away, in one command whose cost scaled with the hash. Measured on the shared store at 39-43ms for the
// largest account, from three pods inside a minute, each blocking its single command thread.
describe('updateSessionState reads field names incrementally', () => {
  it('never asks for values', async () => {
    await refreshSession(42, { sendSignal: false });

    expect(mockHScanNoValues).toHaveBeenCalled();
    // The mocked client surface has no hGetAll at all, so a regression to it throws rather than silently
    // working — but assert the intent explicitly too.
    const [key, cursor, options] = mockHScanNoValues.mock.calls[0];
    expect(key).toBe(`${REDIS_KEYS.SESSION.USER_TOKENS}:42`);
    expect(cursor).toBe('0');
    expect(options.COUNT).toBeGreaterThan(0);
  });

  it('follows the cursor to the end and unions every page', async () => {
    mockHScanNoValues
      .mockResolvedValueOnce({ cursor: '17', fields: ['token-a', 'token-b'] })
      .mockResolvedValueOnce({ cursor: '42', fields: ['token-c'] })
      .mockResolvedValueOnce({ cursor: '0', fields: ['token-d'] });

    await refreshSession(42, { sendSignal: false });

    expect(mockHScanNoValues).toHaveBeenCalledTimes(3);
    expect(mockHScanNoValues.mock.calls[1][1]).toBe('17'); // cursor threaded through
    expect(mockHScanNoValues.mock.calls[2][1]).toBe('42');
    const [, , fieldsObj] = mockHSetMultiWithTTL.mock.calls[0];
    expect(Object.keys(fieldsObj)).toEqual(['token-a', 'token-b', 'token-c', 'token-d']);
  });

  // Each page is raced separately, so the fail-open bound applies per page rather than to the whole scan.
  it('deadline-wraps every page, not just the first', async () => {
    mockHScanNoValues
      .mockResolvedValueOnce({ cursor: '9', fields: ['token-a'] })
      .mockResolvedValueOnce({ cursor: '0', fields: ['token-b'] });

    await refreshSession(42, { sendSignal: false });

    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(2);
  });
});

// 🔴 A bounded primitive repeated an unbounded number of times is not bounded. withSysReadDeadline bounds ONE
// page; the largest production account is 108 pages, so a sysRedis degraded enough that every page returns
// just under its own deadline would hang a logout or ban for minutes while the per-page fail-open never
// trips. Reported by charlie on #3756.
describe('updateSessionState scan is bounded in aggregate', () => {
  it('stops scanning once the total budget is exceeded, instead of following the cursor forever', async () => {
    // Every page returns just under a per-page deadline that therefore never fires.
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let pages = 0;
    mockHScanNoValues.mockImplementation(async () => {
      pages++;
      now += 1900; // just under a 2s per-page deadline
      // The fake MUST terminate on its own. Without the budget under test this is an infinite loop of
      // immediately-resolved awaits — a pure microtask loop, which starves the macrotask queue, so vitest's
      // setTimeout-based testTimeout never fires and CI hangs instead of failing. Measured: 4.19M iterations
      // in 4s with a 300ms setTimeout that never ran. A regression must fail legibly, not wedge the runner —
      // same reasoning as the n=10k cap on the linear-map test below.
      if (pages > 50) return { cursor: '0', fields: [] };
      return { cursor: String(pages), fields: [`token-${pages}`] }; // otherwise never returns to '0'
    });

    await refreshSession(42, { sendSignal: false });
    nowSpy.mockRestore();

    // Without an aggregate bound this loops until the mock stops, i.e. forever.
    expect(pages).toBeLessThan(5);
    // What it did read is still marked — a partial revocation beats none.
    expect(mockHSetMultiWithTTL).toHaveBeenCalledTimes(1);
  });

  it('reports a truncated scan DISTINCTLY, so a partial read is not read as a clean one', async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let pages = 0;
    mockHScanNoValues.mockImplementation(async () => {
      pages++;
      now += 1900;
      if (pages > 50) return { cursor: '0', fields: [] }; // see above — the fake must terminate on its own
      return { cursor: String(pages), fields: [`token-${pages}`] };
    });

    await refreshSession(42, { sendSignal: false });
    nowSpy.mockRestore();

    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn, , extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('read-degraded');
    expect(fn).toContain('truncated');
    expect(extra).toMatchObject({ userId: 42, type: 'refresh' });
  });

  it('does not report truncation on a scan that completes normally', async () => {
    await refreshSession(42, { sendSignal: false });
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  // HSCAN can return the same field twice when the hash rehashes mid-scan. The write dedupes structurally,
  // but the count feeding the log line and the histogram would over-report.
  it('counts each field once when the scan returns duplicates', async () => {
    mockHScanNoValues
      .mockResolvedValueOnce({ cursor: '5', fields: ['token-a', 'token-b'] })
      .mockResolvedValueOnce({ cursor: '0', fields: ['token-b', 'token-c'] });

    await refreshSession(42, { sendSignal: false });

    const [, , fieldsObj] = mockHSetMultiWithTTL.mock.calls[0];
    expect(Object.keys(fieldsObj)).toEqual(['token-a', 'token-b', 'token-c']);
  });
});

// A partial write and a total failure previously produced byte-identical log lines, so "revoked 29 of 54"
// and "revoked 0 of 54" were indistinguishable to whoever read them.
describe('updateSessionState distinguishes a partial write from a total one', () => {
  it('logs how many chunks landed before the throw', async () => {
    mockHSetMultiWithTTL.mockImplementation(async (_c, _k, _f, _ttl, onChunk) => {
      onChunk?.({ durationSeconds: 0.001, fieldCount: 1000, chunkIndex: 0, chunkTotal: 3 });
      onChunk?.({ durationSeconds: 0.001, fieldCount: 1000, chunkIndex: 1, chunkTotal: 3 });
      throw new Error("READONLY You can't write against a read only replica.");
    });

    await expect(refreshSession(42, { sendSignal: false })).resolves.toBeUndefined();

    const [subtype, , , extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('write-degraded');
    expect(extra).toMatchObject({ chunksWritten: 2, chunksTotal: 3 });
  });

  it('reports zero chunks written when the very first one throws', async () => {
    mockHSetMultiWithTTL.mockRejectedValueOnce(new Error('boom'));

    await expect(refreshSession(42, { sendSignal: false })).resolves.toBeUndefined();

    expect(mockLogSysRedisFailOpen.mock.calls[0][3]).toMatchObject({ chunksWritten: 0 });
  });
});
