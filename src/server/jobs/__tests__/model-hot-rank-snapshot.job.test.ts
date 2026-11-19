import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as FliptClient from '~/server/flipt/client';
import type * as PgDb from '~/server/db/pgDb';

/**
 * What protects a good night: a complete day is never rewritten, a bad staging load never reaches
 * the daily table, and the day is marked complete only after the swap. ClickHouse and the Postgres
 * read are faked at their clients; the job runs through createJob as the scheduler runs it.
 */

const { ch, calls, state, queryWithTimeout, isFlipt } = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { runsForDay: 0, stagingRows: undefined as number | undefined, inserted: 0 };
  const ch = {
    query: vi.fn(async ({ query }: { query: string }) => {
      calls.push(query.includes('model_hot_rank_runs') ? 'read:runs' : 'read:staging');
      const row = query.includes('model_hot_rank_runs')
        ? { n: state.runsForDay }
        : {
            rows: state.stagingRows ?? state.inserted,
            ranks: state.stagingRows ?? state.inserted,
            maxRank: state.stagingRows ?? state.inserted,
          };
      return { json: async () => [row] };
    }),
    $exec: vi.fn(async (query: string) => {
      calls.push(query.includes('REPLACE PARTITION') ? 'replace' : 'drop:staging');
    }),
    insert: vi.fn(async ({ table, values }: { table: string; values: unknown[] }) => {
      if (table.endsWith('model_hot_rank_staging')) state.inserted += values.length;
      calls.push(table.endsWith('model_hot_rank_runs') ? 'insert:runs' : 'insert:staging');
    }),
  };
  return { ch, calls, state, queryWithTimeout: vi.fn(), isFlipt: vi.fn() };
});

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: ch,
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout,
}));
vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<typeof PgDb>()),
  pgDbReadLong: {},
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));

const { modelHotRankSnapshotJob } = await import('~/server/jobs/model-hot-rank-snapshot');

const snapshotOf = (n: number) => ({
  modelIds: Array.from({ length: n }, (_, i) => i + 1),
  hotScores: Array(n).fill(1),
  nsfwLevels: Array(n).fill(1),
  availabilities: Array(n).fill('Public'),
  pois: Array(n).fill(false),
  minors: Array(n).fill(false),
  paids: Array(n).fill(false),
  paidPermanents: Array(n).fill(false),
  hidePaidKeeps: Array(n).fill(true),
});

const run = () => modelHotRankSnapshotJob.run({}).result;

beforeEach(() => {
  calls.length = 0;
  Object.assign(state, { runsForDay: 0, stagingRows: undefined, inserted: 0 });
  isFlipt.mockReset().mockResolvedValue(true);
  queryWithTimeout.mockReset().mockResolvedValue({ rows: [snapshotOf(3)] });
});

describe('model-hot-rank-snapshot job', () => {
  it('swaps the checked day in, and marks it complete only after the swap', async () => {
    await expect(run()).resolves.toMatchObject({ rows: 3 });
    expect(calls).toEqual([
      'read:runs',
      'drop:staging',
      'insert:staging',
      'read:staging',
      'replace',
      'insert:runs',
      'drop:staging',
    ]);
  });

  it('leaves a day that is already complete untouched', async () => {
    state.runsForDay = 1;
    await expect(run()).resolves.toMatchObject({ skipped: 'complete' });
    expect(queryWithTimeout).not.toHaveBeenCalled();
    expect(calls).toEqual(['read:runs']);
  });

  it('never swaps or marks a day whose staging load does not match the snapshot', async () => {
    state.stagingRows = 2;
    await expect(run()).rejects.toThrow(/expected 3/);
    expect(calls).not.toContain('replace');
    expect(calls).not.toContain('insert:runs');
  });

  it('writes nothing when the snapshot read returns no models', async () => {
    queryWithTimeout.mockResolvedValue({ rows: [snapshotOf(0)] });
    await expect(run()).rejects.toThrow(/no models/);
    expect(calls).toEqual(['read:runs']);
  });

  it('does nothing with the flag off', async () => {
    isFlipt.mockResolvedValue(false);
    await expect(run()).resolves.toMatchObject({ skipped: 'flag-off' });
    expect(calls).toEqual([]);
    expect(queryWithTimeout).not.toHaveBeenCalled();
  });
});
