import { describe, it, expect } from 'vitest';

// FIX #2: the 30s periodic `_slots.rediscover()` must be env-tunable AND disable-able via
// REDIS_CLUSTER_REFRESH_INTERVAL, so the infra side can run the "lengthen / disable the
// periodic rediscover" experiment (the most plausible SEED of the inflight-leak wedge) as a
// pure env change. resolvePeriodicRefresh encodes that decision purely so we can pin it:
// 0 (or negative) = the disable sentinel; a value lengthens; unset = the schema default 30s.
//
// client.ts opens TCP sockets at module load via getCacheClient(); stub the redis factories +
// the Flipt client so importing it is side-effect-free (mirrors client.test.ts).
import { vi } from 'vitest';
vi.mock('redis', () => {
  const noopClient = () => {
    const client: any = {
      on: () => client,
      connect: vi.fn(() => Promise.resolve()),
      withTypeMapping: vi.fn(() => client),
      scan: vi.fn(),
      mGet: vi.fn(),
      del: vi.fn(),
      unlink: vi.fn(),
    };
    return client;
  };
  return {
    createClient: vi.fn(noopClient),
    createCluster: vi.fn(noopClient),
    createSentinel: vi.fn(noopClient),
    RESP_TYPES: { BLOB_STRING: 'BLOB_STRING' },
  };
});
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { REDIS_CLUSTER_ENHANCED_FAILOVER: 'redis_cluster_enhanced_failover' },
  isFlipt: vi.fn(() => Promise.resolve(false)),
}));

import { resolvePeriodicRefresh } from '~/server/redis/client';

describe('resolvePeriodicRefresh (FIX #2 — env-disable-able topology rediscover)', () => {
  it('0 is the DISABLE sentinel: no periodic rediscover scheduled', () => {
    expect(resolvePeriodicRefresh(0)).toEqual({ enabled: false, intervalMs: 0 });
  });

  it('a negative value also disables (sentinel is <= 0)', () => {
    expect(resolvePeriodicRefresh(-1)).toEqual({ enabled: false, intervalMs: 0 });
  });

  it('the default 30000 (unset env) keeps the standing 30s behavior — UNCHANGED', () => {
    // server-schema defaults REDIS_CLUSTER_REFRESH_INTERVAL to 30000 when unset.
    expect(resolvePeriodicRefresh(30000)).toEqual({ enabled: true, intervalMs: 30000 });
  });

  it('a LARGER value lengthens the interval (the experiment lever)', () => {
    expect(resolvePeriodicRefresh(120000)).toEqual({ enabled: true, intervalMs: 120000 });
  });

  it('a smaller positive value shortens it (still enabled)', () => {
    expect(resolvePeriodicRefresh(5000)).toEqual({ enabled: true, intervalMs: 5000 });
  });

  it('a non-finite value (mis-set env) falls back to the 30s default rather than silently disabling', () => {
    expect(resolvePeriodicRefresh(NaN)).toEqual({ enabled: true, intervalMs: 30000 });
    expect(resolvePeriodicRefresh(Infinity)).toEqual({ enabled: true, intervalMs: 30000 });
  });
});
