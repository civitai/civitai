import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the prod 500-floor bug:
//   ERR wrong number of arguments for 'zrem' command  (~6/3h)
// createCounter().reset({ id: [] }) called ZREM/HDEL with no members, which
// Redis rejects. An empty id array must be a no-op (resolve to 0, no redis call).

const { mockRedis, mockSysRedis } = vi.hoisted(() => ({
  mockRedis: {},
  mockSysRedis: {
    zRem: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: {},
  REDIS_SYS_KEYS: {
    NEW_ORDER: {
      FERVOR: 'new-order:fervor',
      SANITY_CHECKS: { FAILURES: 'new-order:sanity-check-failures' },
      // The factory reads these at module load; supply the ones the imported
      // counters reference plus harmless stand-ins for the rest.
      JUDGEMENTS: { ACOLYTE_FAILED: 'new-order:acolyte-failed' },
      EXP: 'new-order:exp',
      BUZZ: 'new-order:blessed-buzz',
      PENDING_BUZZ: 'new-order:pending-buzz',
      RECENTLY_GRANTED_BUZZ: 'new-order:recently-granted-buzz',
      SMITE: 'new-order:smite-progress',
      QUEUES: 'new-order:queues',
      IMAGE_RATINGS: 'new-order:image-ratings',
    },
  },
}));

vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: vi.fn(),
  zAddWithTTL: vi.fn(),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/client', () => ({ dbRead: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: vi.fn() }));

import { fervorCounter, sanityCheckFailuresCounter } from '~/server/games/new-order/utils';

describe('createCounter().reset — empty id array guard', () => {
  beforeEach(() => {
    mockSysRedis.zRem.mockClear();
    mockSysRedis.hDel.mockClear();
    mockSysRedis.del.mockClear();
  });

  it('ordered counter: reset with [] does not call zRem and resolves to 0', async () => {
    const result = await fervorCounter.reset({ id: [] });
    expect(mockSysRedis.zRem).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  it('unordered counter: reset with [] does not call hDel and resolves to 0', async () => {
    const result = await sanityCheckFailuresCounter.reset({ id: [] });
    expect(mockSysRedis.hDel).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  it('ordered counter: reset with non-empty ids still calls zRem', async () => {
    await fervorCounter.reset({ id: [1, 2] });
    expect(mockSysRedis.zRem).toHaveBeenCalledTimes(1);
    expect(mockSysRedis.zRem).toHaveBeenCalledWith('new-order:fervor', ['1', '2']);
  });

  it('unordered counter: reset with non-empty ids still calls hDel', async () => {
    await sanityCheckFailuresCounter.reset({ id: [3] });
    expect(mockSysRedis.hDel).toHaveBeenCalledTimes(1);
    expect(mockSysRedis.hDel).toHaveBeenCalledWith('new-order:sanity-check-failures', ['3']);
  });
});
