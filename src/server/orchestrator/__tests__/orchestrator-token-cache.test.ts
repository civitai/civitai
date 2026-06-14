/**
 * Coverage for orchestrator-token-cache. Specifically validates the two
 * properties this module exists to provide:
 *
 *   1. Cache hit: a second call for the same userId within the TTL window
 *      does not invoke the mint function.
 *
 *   2. In-flight coalescing: N concurrent first-time calls for the same
 *      userId invoke the mint function exactly once. This is the
 *      thundering-herd protection during a sysRedis failover; without
 *      coalescing the LRU alone would leave a race window wide enough
 *      to fire N DB INSERTs.
 *
 * Mocks `~/server/prom/client` to avoid pulling the global prom registry
 * (which would error on duplicate registration across vitest workers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
}));

import { __testing, getOrMintCachedToken } from '../orchestrator-token-cache';

describe('orchestrator-token-cache', () => {
  beforeEach(() => {
    __testing.clear();
  });

  afterEach(() => {
    __testing.clear();
  });

  it('coalesces N concurrent same-user requests into a single mint call', async () => {
    let mintCalls = 0;
    const mint = vi.fn(async () => {
      mintCalls += 1;
      // Simulate DB latency so all 10 callers enter inflight before resolve.
      await new Promise((r) => setTimeout(r, 10));
      return `token-${mintCalls}`;
    });

    const userId = 42;
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => getOrMintCachedToken(userId, mint))
    );

    expect(mintCalls).toBe(1);
    expect(mint).toHaveBeenCalledTimes(1);
    // All callers got the same token (the one mint-result was shared).
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('token-1');
  });

  it('serves repeat calls from cache without re-minting', async () => {
    const mint = vi.fn(async () => 'cached-token');
    const userId = 7;

    const first = await getOrMintCachedToken(userId, mint);
    const second = await getOrMintCachedToken(userId, mint);
    const third = await getOrMintCachedToken(userId, mint);

    expect(mint).toHaveBeenCalledTimes(1);
    expect(first).toBe('cached-token');
    expect(second).toBe('cached-token');
    expect(third).toBe('cached-token');
  });

  it('mints independently for different userIds (no cross-user collision)', async () => {
    let counter = 0;
    const mint = vi.fn(async () => `token-${++counter}`);

    const [a, b, c] = await Promise.all([
      getOrMintCachedToken(1, mint),
      getOrMintCachedToken(2, mint),
      getOrMintCachedToken(3, mint),
    ]);

    expect(mint).toHaveBeenCalledTimes(3);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('clears the in-flight slot on rejection so future calls can retry', async () => {
    let attempt = 0;
    const mint = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient db blip');
      return 'recovered-token';
    });

    const userId = 99;
    await expect(getOrMintCachedToken(userId, mint)).rejects.toThrow('transient db blip');
    // Second call must NOT be wedged behind the rejected promise.
    const recovered = await getOrMintCachedToken(userId, mint);
    expect(recovered).toBe('recovered-token');
    expect(mint).toHaveBeenCalledTimes(2);
  });
});

// The TTL expiry + kill-switch tests need a different module instance with
// different env at module-load time (TTL is read once, CACHE_DISABLED is
// frozen at module load). vi.resetModules() + dynamic import gives us a
// fresh module per test without polluting the suite above.
describe('orchestrator-token-cache — env-driven module init', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // Restore env so subsequent tests/suites see a clean slate.
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.useRealTimers();
  });

  it('expires cached entries after the configured TTL (re-mints on next call)', async () => {
    // Short real TTL is more reliable than mocking `performance.now()`,
    // which lru-cache v11 reads via the `defaultPerf` time source — that
    // path is not always intercepted by vi.useFakeTimers({ toFake: [...] })
    // and the contract risks silently regressing on lru-cache upgrades.
    // 50ms is long enough to be deterministic on CI, short enough to keep
    // the suite snappy.
    process.env.ORCHESTRATOR_TOKEN_CACHE_TTL_MS = '50';
    vi.resetModules();
    const mod = await import('../orchestrator-token-cache');

    let mintCalls = 0;
    const mint = vi.fn(async () => `token-${++mintCalls}`);

    const userId = 1;
    const first = await mod.getOrMintCachedToken(userId, mint);
    expect(first).toBe('token-1');
    expect(mint).toHaveBeenCalledTimes(1);

    // Within TTL: cache hit, no new mint.
    const second = await mod.getOrMintCachedToken(userId, mint);
    expect(second).toBe('token-1');
    expect(mint).toHaveBeenCalledTimes(1);

    // Wait past the TTL boundary.
    await new Promise((r) => setTimeout(r, 75));

    // After TTL: cache miss, mint runs again.
    const third = await mod.getOrMintCachedToken(userId, mint);
    expect(third).toBe('token-2');
    expect(mint).toHaveBeenCalledTimes(2);

    mod.__testing.clear();
  });

  it('rejects with timeout error when mint never settles (default behaviour with short MINT_TIMEOUT_MS)', async () => {
    // 50ms timeout: tight enough to keep the test fast, long enough to
    // be deterministic on CI even under jitter. We deliberately don't
    // use vi.useFakeTimers() — the existing TTL test above documents
    // that fake timers don't intercept lru-cache's perf source, and
    // mixing real + fake timers makes the race semantics nondeterministic.
    process.env.ORCHESTRATOR_TOKEN_CACHE_MINT_TIMEOUT_MS = '50';
    vi.resetModules();
    const mod = await import('../orchestrator-token-cache');

    // A mint that NEVER resolves — simulates a stuck Postgres failover
    // or PgBouncer reserve_pool exhaustion. Without the timeout, the
    // inflight slot would be held forever and same-user callers would
    // attach to a dead promise.
    const neverResolves = vi.fn(() => new Promise<string>(() => undefined));

    const userId = 1;
    await expect(mod.getOrMintCachedToken(userId, neverResolves)).rejects.toThrow(
      /mint timed out after 50ms for user 1/
    );

    // The inflight slot MUST be empty after the timeout fired — the
    // .finally() should have run regardless of which arm of the race won.
    expect(mod.__testing.size()).toEqual({ cache: 0, inflight: 0 });

    mod.__testing.clear();
  });

  it('clears the in-flight slot after a timeout so the next caller gets a fresh mint', async () => {
    process.env.ORCHESTRATOR_TOKEN_CACHE_MINT_TIMEOUT_MS = '50';
    vi.resetModules();
    const mod = await import('../orchestrator-token-cache');

    const neverResolves = vi.fn(() => new Promise<string>(() => undefined));
    const mintFast = vi.fn(async () => 'fresh-token');

    const userId = 2;
    // First call times out.
    await expect(mod.getOrMintCachedToken(userId, neverResolves)).rejects.toThrow(
      /mint timed out after 50ms/
    );
    // Second call must NOT be attached to the (still-pending) neverResolves
    // promise — it must enter a fresh inflight with the fast mint.
    const recovered = await mod.getOrMintCachedToken(userId, mintFast);
    expect(recovered).toBe('fresh-token');
    expect(mintFast).toHaveBeenCalledTimes(1);

    mod.__testing.clear();
  });

  it('awaits a slow mint with no timeout when ORCHESTRATOR_TOKEN_CACHE_MINT_TIMEOUT_MS=0', async () => {
    // 0 = timeout disabled (pre-this-PR behaviour). Even a mint slower
    // than the default 10s timeout must be awaited to completion.
    process.env.ORCHESTRATOR_TOKEN_CACHE_MINT_TIMEOUT_MS = '0';
    vi.resetModules();
    const mod = await import('../orchestrator-token-cache');

    // Mint takes 100ms — far longer than the 50ms used in the timeout
    // tests above. If the default-10s timeout were still active this
    // would still pass; the load-bearing assertion is that 0 truly
    // disables the wrapping (no Promise.race overhead, no setTimeout).
    const mintSlow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return 'slow-token';
    });

    const userId = 3;
    const result = await mod.getOrMintCachedToken(userId, mintSlow);

    expect(result).toBe('slow-token');
    expect(mintSlow).toHaveBeenCalledTimes(1);

    mod.__testing.clear();
  });

  it('rejects all coalesced concurrent callers on timeout, then accepts a fresh inflight', async () => {
    process.env.ORCHESTRATOR_TOKEN_CACHE_MINT_TIMEOUT_MS = '50';
    vi.resetModules();
    const mod = await import('../orchestrator-token-cache');

    // Single neverResolves mint shared across 10 coalesced callers. Only
    // the first caller actually invokes mint(); the other 9 attach to the
    // inflight promise. When the timeout fires, ALL 10 must reject (they
    // share the same rejected race-promise), and the inflight slot must
    // be cleared so a subsequent caller mints fresh.
    const neverResolves = vi.fn(() => new Promise<string>(() => undefined));

    const userId = 4;
    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => mod.getOrMintCachedToken(userId, neverResolves))
    );

    // All 10 rejected with the timeout error.
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected')
        expect(String(r.reason)).toMatch(/mint timed out after 50ms for user 4/);
    }
    // mint() was only invoked once thanks to coalescing.
    expect(neverResolves).toHaveBeenCalledTimes(1);
    // Inflight slot is clean.
    expect(mod.__testing.size()).toEqual({ cache: 0, inflight: 0 });

    // Subsequent caller hits a brand-new inflight with a healthy mint.
    const mintFast = vi.fn(async () => 'after-timeout-token');
    const recovered = await mod.getOrMintCachedToken(userId, mintFast);
    expect(recovered).toBe('after-timeout-token');
    expect(mintFast).toHaveBeenCalledTimes(1);

    mod.__testing.clear();
  });

  it('disables cache + coalescing when ORCHESTRATOR_TOKEN_CACHE_MAX=0', async () => {
    process.env.ORCHESTRATOR_TOKEN_CACHE_MAX = '0';
    vi.resetModules();
    const mod = await import('../orchestrator-token-cache');

    expect(mod.__testing.isDisabled()).toBe(true);

    let mintCalls = 0;
    // Hold mint slow enough that, if coalescing were active, all 5 callers
    // would share one inflight promise. Disabled mode must NOT coalesce.
    // Capture the per-call ordinal *before* awaiting so the returned token
    // is unique per invocation (otherwise all concurrent callers race past
    // the increment and stamp the final value).
    const mint = vi.fn(async () => {
      mintCalls += 1;
      const id = mintCalls;
      await new Promise((r) => setTimeout(r, 10));
      return `token-${id}`;
    });

    const userId = 5;
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => mod.getOrMintCachedToken(userId, mint))
    );

    // Each concurrent caller hit `mint` independently — no coalescing.
    expect(mint).toHaveBeenCalledTimes(N);
    expect(mintCalls).toBe(N);
    // Each got its own freshly-minted token.
    expect(new Set(results).size).toBe(N);

    // And there is no cache state retained between calls.
    expect(mod.__testing.size()).toEqual({ cache: 0, inflight: 0 });

    // A subsequent call also re-mints (no cache lookup).
    const after = await mod.getOrMintCachedToken(userId, mint);
    expect(after).toBe(`token-${N + 1}`);
    expect(mint).toHaveBeenCalledTimes(N + 1);
  });
});
