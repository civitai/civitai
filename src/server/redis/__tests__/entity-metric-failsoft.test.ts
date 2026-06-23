import { describe, it, expect, vi, beforeEach } from 'vitest';

// FIX #3 at the real WRITE call site: EntityMetricRedisClient.increment is the hot engagement
// counter (hIncrBy + expire). When the cluster client is wedged these commands must FAIL SOFT
// — the increment returns 0 (the only consumer is a < 0 negative-correction, which 0 skips)
// and the expire no-ops — so a wedged pod can NEVER 500/park the user mutation that triggered
// the count. We mock the redis client + env so a hung hIncrBy is deterministic.

// Short fail-fast timeout so the hung-command test is fast; cluster fallback large.
vi.mock('~/env/server', () => ({
  env: {
    REDIS_METRIC_WRITE_TIMEOUT_MS: 20,
    REDIS_CLUSTER_COMMAND_TIMEOUT_MS: 15000,
    LOGGING: [] as string[], // createLogger reads env.LOGGING.includes(name)
  },
}));

// Fake redis client injected into EntityMetricRedisClient via the constructor.
// vi.hoisted so the spies exist before the hoisted vi.mock factory runs.
const { hIncrBy, expire } = vi.hoisted(() => ({ hIncrBy: vi.fn(), expire: vi.fn() }));
vi.mock('~/server/redis/client', () => ({
  redis: { hIncrBy, expire },
  REDIS_KEYS: { ENTITY_METRICS: { BASE: 'packed:entitymetric' } },
}));

import { EntityMetricRedisClient } from '../entity-metric.redis';
import { redis } from '~/server/redis/client';

const never = () => new Promise<never>(() => {});

describe('EntityMetricRedisClient.increment fail-soft (FIX #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: returns the real hIncrBy total and sets the TTL (unchanged)', async () => {
    hIncrBy.mockResolvedValue(7);
    expire.mockResolvedValue(true);
    const client = new EntityMetricRedisClient(redis as any);

    const result = await client.increment('Image', 123, 'ReactionLike', 1);

    expect(result).toBe(7);
    expect(hIncrBy).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('fails soft when hIncrBy HANGS: resolves to 0 (no throw, the user mutation survives)', async () => {
    hIncrBy.mockImplementation(never); // wedged cluster client
    expire.mockResolvedValue(true);
    const client = new EntityMetricRedisClient(redis as any);

    // The contract: this resolves (to 0), it does NOT reject — so the caller's mutation
    // completes instead of 500ing.
    await expect(client.increment('Image', 123, 'ReactionLike', 1)).resolves.toBe(0);
  });

  it('fails soft when hIncrBy ERRORS (e.g. CROSSSLOT): resolves to 0, does not throw', async () => {
    hIncrBy.mockRejectedValue(new Error('CROSSSLOT'));
    expire.mockResolvedValue(true);
    const client = new EntityMetricRedisClient(redis as any);

    await expect(client.increment('Image', 123, 'ReactionLike', 1)).resolves.toBe(0);
  });

  it('a hung expire does not throw out of increment either', async () => {
    hIncrBy.mockResolvedValue(3);
    expire.mockImplementation(never);
    const client = new EntityMetricRedisClient(redis as any);

    // Even if expire wedges, increment still resolves with the real total — the sliding TTL
    // is best-effort.
    await expect(client.increment('Image', 123, 'ReactionLike', 1)).resolves.toBe(3);
  });
});
