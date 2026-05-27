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
