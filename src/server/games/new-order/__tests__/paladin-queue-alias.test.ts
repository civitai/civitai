import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  redis: {},
  sysRedis: {},
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(), zAddWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: vi.fn() }));

import { poolCounters, poolKeys } from '~/server/games/new-order/utils';

// The Knights app promotes players to Paladin. Anything in the original game that indexes
// a queue by a player's rank must still find one.
describe('Paladin in the original game queues', () => {
  it('shares the Templar pools instead of having none', () => {
    expect(poolKeys.Paladin).toBe(poolKeys.Templar);
    expect(poolCounters.Paladin).toBe(poolCounters.Templar);
    expect(poolCounters.Paladin.a.length).toBeGreaterThan(0);
  });
});
