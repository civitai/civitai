import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The creator dashboard's Generation Buzz Earned chart reads one source bucket at a time from
 * `orchestration.resourceCompensations`. Tips land there as `source = 'tip'` (first rows 2026-10-08),
 * and Compensation used to be "everything but licenseFee", so every creator's tips showed up as
 * Compensation. Tips are their own tab now.
 */

const { $query } = vi.hoisted(() => ({ $query: vi.fn() }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query },
}));

import { getDailyCompensationRewardByUser } from '~/server/services/buzz.service';

// The source predicate exactly as the query renders it, operator included.
const sourcePredicate = () => {
  const [strings, ...values] = $query.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const sql = strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ''), '');
  const match = sql.match(/^\s*AND source (.+)$/m);
  return match?.[1].trim();
};

beforeEach(() => {
  $query.mockReset();
  $query.mockResolvedValue([]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
    { id: 11, name: 'v1', model: { name: 'Model' } },
  ]);
});

describe('getDailyCompensationRewardByUser source buckets', () => {
  it('Compensation excludes tips as well as license fees', async () => {
    await getDailyCompensationRewardByUser({ userId: 1, date: new Date(), source: 'compensation' });
    // NOT IN rather than `= 'compensation'`, so one-off sources such as
    // `compensation_recovered_20260507` stay counted as compensation.
    expect(sourcePredicate()).toBe("NOT IN ('licenseFee', 'tip')");
  });

  it('Tips reads only tip rows', async () => {
    await getDailyCompensationRewardByUser({ userId: 1, date: new Date(), source: 'tip' });
    expect(sourcePredicate()).toBe("= 'tip'");
  });

  it('License Fees reads only license fee rows', async () => {
    await getDailyCompensationRewardByUser({ userId: 1, date: new Date(), source: 'licenseFee' });
    expect(sourcePredicate()).toBe("= 'licenseFee'");
  });
});
