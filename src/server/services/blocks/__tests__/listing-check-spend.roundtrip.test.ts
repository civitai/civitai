import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  agentReviewSpendTodayUsd,
  recordListingCheckSpendUsd,
} from '~/server/services/blocks/review-autodeploy.service';

/**
 * The listing-edit impersonation check's spend, ROUND-TRIPPED: written by the real
 * `recordListingCheckSpendUsd` into a Redis stand-in that behaves like one (SET NX + INCRBY on a
 * key, GET reads it back), then read by the real `agentReviewSpendTodayUsd`. Pins that the writer
 * and the reader agree on the key and the unit (US cents), and the one-cent floor.
 */

const store = new Map<string, number>();

function installRedis() {
  redisMock.sysRedis.multi.mockImplementation((() => {
    const ops: Array<() => unknown> = [];
    const chain = {
      set: (key: string, value: string, opts?: { NX?: boolean }) => {
        ops.push(() => {
          if (opts?.NX && store.has(key)) return null;
          store.set(key, Number(value));
          return 'OK';
        });
        return chain;
      },
      incrBy: (key: string, by: number) => {
        ops.push(() => {
          const next = (store.get(key) ?? 0) + by;
          store.set(key, next);
          return next;
        });
        return chain;
      },
      exec: async () => ops.map((op) => op()),
    };
    return chain;
  }) as never);
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    store.has(key) ? String(store.get(key)) : null) as never);
}

beforeEach(() => {
  resetHybridNodes();
  store.clear();
  installRedis();
  // No agent reviews today: the listing-check spend is the whole total.
  dbMock.dbWrite.appReviewAgentReport.aggregate.mockResolvedValue({
    _sum: { costUsd: 0 },
  } as never);
  dbMock.dbWrite.appReviewAgentReport.count.mockResolvedValue(0 as never);
});

describe('listing-check spend: recorded by one function, read back by the budget', () => {
  it('🔴 what is recorded is what the day’s spend reads', async () => {
    expect(await agentReviewSpendTodayUsd()).toBe(0);
    await recordListingCheckSpendUsd(0.25);
    expect(await agentReviewSpendTodayUsd()).toBeCloseTo(0.25, 10);
    await recordListingCheckSpendUsd(0.5);
    expect(await agentReviewSpendTodayUsd()).toBeCloseTo(0.75, 10);
  });

  it('🔴 a sub-cent check is counted at the one-cent floor, never as nothing', async () => {
    await recordListingCheckSpendUsd(0.0006);
    expect(await agentReviewSpendTodayUsd()).toBeCloseTo(0.01, 10);
  });

  it('zero, negative or non-finite amounts record nothing', async () => {
    for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await recordListingCheckSpendUsd(usd);
    }
    expect(await agentReviewSpendTodayUsd()).toBe(0);
    expect(store.size).toBe(0);
  });
});
