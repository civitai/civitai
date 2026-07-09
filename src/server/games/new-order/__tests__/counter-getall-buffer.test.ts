import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression: the HA/Sentinel sysRedis client returns BLOB_STRING replies as a
// Buffer. getImageRatingsCounter().getAll() returns zset MEMBERS, and
// checkWeightedConsensus does `vote.value.split('-')` on them — a Buffer has no
// `.split`, so it threw `value.split is not a function`, was swallowed by the
// surrounding try/catch, and returned undefined for EVERY image that reached
// consensus → mass Inconclusive purges + KoN earnings collapse. getAll must
// decode members to utf8 so callers get the string they're typed to receive.

const { mockSysRedis } = vi.hoisted(() => ({
  mockSysRedis: {
    zRangeWithScores: vi.fn(),
    zRem: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('~/server/redis/client', () => ({
  redis: {},
  sysRedis: mockSysRedis,
  REDIS_KEYS: {},
  REDIS_SYS_KEYS: {
    NEW_ORDER: {
      FERVOR: 'new-order:fervor',
      SANITY_CHECKS: { FAILURES: 'new-order:sanity-check-failures' },
      JUDGEMENTS: { ACOLYTE_FAILED: 'new-order:acolyte-failed' },
      EXP: 'new-order:exp',
      BUZZ: 'new-order:blessed-buzz',
      PENDING_BUZZ: 'new-order:pending-buzz',
      RECENTLY_GRANTED_BUZZ: 'new-order:recently-granted-buzz',
      SMITE: 'new-order:smite-progress',
      QUEUES: 'new-order:queues',
      RATINGS: 'new-order:ratings',
    },
  },
}));

vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(), zAddWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/client', () => ({ dbRead: {} }));

import { getImageRatingsCounter } from '~/server/games/new-order/utils';

beforeEach(() => vi.clearAllMocks());

describe('createCounter.getAll — BLOB_STRING/Buffer member decoding', () => {
  it('decodes Buffer members to utf8 strings so vote.value.split works', async () => {
    mockSysRedis.zRangeWithScores.mockResolvedValue([
      { value: Buffer.from('Knight-4', 'utf8'), score: 510 },
      { value: Buffer.from('Knight-8', 'utf8'), score: 122 },
    ]);

    const votes = await getImageRatingsCounter(123).getAll({ withCount: true });

    expect(votes.map((v) => v.value)).toEqual(['Knight-4', 'Knight-8']);
    // The exact operation that crashed in checkWeightedConsensus:
    expect(() => Number(votes[0].value.split('-')[1])).not.toThrow();
    expect(Number(votes[0].value.split('-')[1])).toBe(4);
    expect(votes[0].score).toBe(510);
  });

  it('leaves plain string members unchanged (single-node/dev behavior)', async () => {
    mockSysRedis.zRangeWithScores.mockResolvedValue([{ value: 'Knight-1', score: 632 }]);

    const votes = await getImageRatingsCounter(123).getAll({ withCount: true });

    expect(votes).toEqual([{ value: 'Knight-1', score: 632 }]);
  });

  it('decodes Buffer members in the non-withCount path too', async () => {
    mockSysRedis.zRangeWithScores.mockResolvedValue([
      { value: Buffer.from('Knight-2', 'utf8'), score: 300 },
    ]);

    const members = await getImageRatingsCounter(123).getAll();

    expect(members).toEqual(['Knight-2']);
  });
});
