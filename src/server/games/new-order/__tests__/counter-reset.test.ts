import { describe, it, expect, vi, beforeEach } from 'vitest';
// The REAL key constants — `~/server/redis/client` is mocked below, the PACKAGE it
// re-exports is not, so the assertion cannot drift from production again.
import { REDIS_SYS_KEYS } from '@civitai/redis/client';

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

// 🔴 Spread the REAL package for the key constants rather than re-typing them. The
// hand-typed block that used to sit here had to enumerate every key the counter factory
// reads at module load, and two of them had drifted: SANITY_CHECKS.FAILURES read
// 'new-order:sanity-check-failures' against the real 'new-order:sanity-failures', and
// JUDGEMENTS.ACOLYTE_FAILED dropped the 'judgments:' segment. It also declared an
// IMAGE_RATINGS key that exists nowhere in the codebase outside this file. Spreading the
// package removes the enumeration entirely, so a key added to the factory tomorrow needs no
// edit here and cannot be stubbed with the wrong value.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  redis: mockRedis,
  sysRedis: mockSysRedis,
}));

vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: vi.fn(),
  zAddWithTTL: vi.fn(),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: vi.fn() }));

import { fervorCounter, sanityCheckFailuresCounter } from '~/server/games/new-order/utils';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

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
    expect(mockSysRedis.hDel).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.FAILURES,
      ['3']
    );
  });
});
