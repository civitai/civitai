import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  runActivityGroup: vi.fn(),
  loadStoredMilestoneGroups: vi.fn(),
  clickhouseQuery: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { query: mocks.clickhouseQuery },
}));

vi.mock('~/server/services/creator-milestone-stored', async (importOriginal) => ({
  ...(await importOriginal<typeof StoredService>()),
  loadStoredMilestoneGroups: mocks.loadStoredMilestoneGroups,
}));

vi.mock('~/server/services/creator-milestone-activity.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ActivityService>()),
  runActivityGroup: mocks.runActivityGroup,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as ActivityService from '~/server/services/creator-milestone-activity.service';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as StoredService from '~/server/services/creator-milestone-stored';
import { StoredMilestoneSkip } from '~/server/services/creator-milestone-stored';
import {
  grantCreatorMilestones,
  keyValueWatermarkStore,
  memoizedAudience,
  queryClickhouse,
} from '~/server/jobs/grant-creator-milestones';
import {
  activityDetectorGroups,
  competeWinGroups,
  judgeVoteGroups,
  ledgerWinsSql,
} from '~/server/services/creator-milestone-detectors';

const codeGroups = () => [
  ...activityDetectorGroups(),
  ...judgeVoteGroups(queryClickhouse),
  ...competeWinGroups(queryClickhouse),
];

beforeEach(() => {
  mocks.kv.clear();
  mocks.runActivityGroup.mockReset();
  mocks.loadStoredMilestoneGroups.mockReset().mockResolvedValue([]);
  loggingMock.logToAxiom.mockClear();
  dbMock.dbWrite.keyValue.findUnique.mockImplementation(
    async ({ where }: { where: { key: string } }) =>
      mocks.kv.has(where.key) ? { key: where.key, value: mocks.kv.get(where.key) } : null
  );
  dbMock.dbWrite.keyValue.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { value: unknown };
      update: { value: unknown };
    }) => mocks.kv.set(where.key, mocks.kv.has(where.key) ? update.value : create.value)
  );
});

// The production store is what decides whether a watermark exists. A get that invents one announces
// every publish since launch; a round trip that loses it silences every run for good.
describe('keyValueWatermarkStore', () => {
  it('reads back what it wrote', async () => {
    const watermark = { at: 1234, gated: false, definitions: 'create:models-1=1' };
    await keyValueWatermarkStore.set('k', watermark);
    expect(await keyValueWatermarkStore.get('k')).toEqual(watermark);
  });

  it.each([
    ['a missing row', undefined],
    ['a bare job-date number', 1234],
    ['a stringly time', { at: '1234', gated: false, definitions: 'x' }],
    ['no gated flag', { at: 1234, definitions: 'x' }],
    ['no definitions', { at: 1234, gated: false }],
  ])('reads %s as no watermark', async (_, value) => {
    if (value !== undefined) mocks.kv.set('k', value);
    expect(await keyValueWatermarkStore.get('k')).toBeNull();
  });
});

describe('memoizedAudience', () => {
  it('evaluates each user once across calls, and answers each call for its own users', async () => {
    const evaluate = vi.fn(async (ids: number[]) => new Set(ids.filter((id) => id % 2 === 0)));
    const audience = memoizedAudience(evaluate);
    expect([...(await audience([1, 2, 3]))]).toEqual([2]);
    expect([...(await audience([2, 3, 4]))]).toEqual([2, 4]);
    expect(evaluate.mock.calls).toEqual([[[1, 2, 3]], [[4]]]);
  });
});

describe('grant-creator-milestones', () => {
  // Flag membership changes between nights; a memo that outlived its run would keep telling users who left.
  it('evaluates the audience afresh on every run', async () => {
    const seen: unknown[] = [];
    mocks.runActivityGroup.mockImplementation(
      async (_: unknown, deps: { audienceAmong: unknown }) => {
        seen.push(deps.audienceAmong);
        return {};
      }
    );
    await grantCreatorMilestones.run({} as never).result;
    await grantCreatorMilestones.run({} as never).result;
    const groups = codeGroups().length;
    expect(seen).toHaveLength(2 * groups);
    expect(new Set(seen.slice(0, groups)).size).toBe(1);
    expect(seen[0]).not.toBe(seen[groups]);
  });

  const run = () =>
    grantCreatorMilestones.run({} as never).result as Promise<Record<string, unknown> | undefined>;

  it('runs every group even when one fails, then fails the run naming it', async () => {
    const groups = codeGroups();
    mocks.runActivityGroup.mockImplementation(async (group: { id: string }) => {
      if (group.id === groups[0].id) throw new Error('boom');
      return { granted: 0 };
    });
    await expect(run()).rejects.toThrow(`1 group(s) failed: ${groups[0].id}`);
    expect(mocks.runActivityGroup.mock.calls.map(([group]) => group.id)).toEqual(
      groups.map((group) => group.id)
    );
  });

  const storedGroup = { id: 'stored:test:x', keys: ['test:x'], candidates: vi.fn() };
  const storedReports = () =>
    loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.name === 'creator-milestone-stored');

  it('runs the judge ranks alongside the activity groups, reading the real ClickHouse', async () => {
    mocks.runActivityGroup.mockResolvedValue({ granted: 0 });
    await run();
    const judge = mocks.runActivityGroup.mock.calls
      .map(([group]) => group)
      .find((group) => group.keys.includes('community:crucible-votes-500'));
    mocks.clickhouseQuery.mockResolvedValue({ json: async () => [] });
    const readPg = {
      cancellableQuery: async () => ({ result: async () => [{ min: 500 }], cancel: vi.fn() }),
    };
    expect(await judge.candidates(readPg)).toEqual([]);
    expect(mocks.clickhouseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('FROM crucible_votes WHERE userId > 0'),
        clickhouse_settings: expect.objectContaining({ readonly: '1' }),
      })
    );
    expect(mocks.runActivityGroup.mock.calls.map(([group]) => group.keys)).toContainEqual([
      'community:crucible-votes-500',
      'community:crucible-votes-1000',
      'community:crucible-votes-5000',
      'community:crucible-votes-10000',
      'community:crucible-votes-25000',
    ]);
  });

  it('runs the compete wins alongside the activity groups, reading the ledger from the real ClickHouse', async () => {
    mocks.runActivityGroup.mockResolvedValue({ granted: 0 });
    await run();
    const compete = mocks.runActivityGroup.mock.calls
      .map(([group]) => group)
      .find((group) => group.keys.includes('compete:wins-1'));
    expect(compete.keys).toEqual([
      'compete:wins-1',
      'compete:wins-5',
      'compete:wins-10',
      'compete:wins-25',
      'compete:wins-100',
    ]);
    mocks.clickhouseQuery.mockResolvedValue({ json: async () => [] });
    const readPg = {
      cancellableQuery: async () => ({ result: async () => [], cancel: vi.fn() }),
    };
    expect(await compete.candidates(readPg)).toEqual([]);
    expect(mocks.clickhouseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: ledgerWinsSql,
        clickhouse_settings: expect.objectContaining({ readonly: '1' }),
      })
    );
  });

  // The nightly check reads these entries by key; a code group reported as stored is a false row.
  it('reports only stored definitions as stored, never the row-by-row judge group', async () => {
    mocks.runActivityGroup.mockResolvedValue({ granted: 0 });
    await run();
    expect(storedReports()).toEqual([]);
  });

  it('runs stored groups after the code ones, and a skipped one does not fail the run', async () => {
    mocks.loadStoredMilestoneGroups.mockResolvedValue([storedGroup]);
    mocks.runActivityGroup.mockImplementation(async (group: { id: string }) => {
      if (group.id === storedGroup.id) throw new StoredMilestoneSkip('test:x', 'shape');
      return { granted: 0 };
    });
    const results = await run();
    expect(results?.[storedGroup.id]).toEqual({ skipped: 'shape' });
    expect(storedReports()).toEqual([
      {
        type: 'info',
        name: 'creator-milestone-stored',
        milestoneKey: 'test:x',
        outcome: 'skipped',
        reason: 'shape',
        code: undefined,
        ms: expect.any(Number),
      },
    ]);
    expect(mocks.runActivityGroup.mock.calls.map(([group]) => group.id)).toEqual([
      ...codeGroups().map((group) => group.id),
      storedGroup.id,
    ]);
  });

  it('still fails the run when a stored group breaks in any other way', async () => {
    mocks.loadStoredMilestoneGroups.mockResolvedValue([storedGroup]);
    mocks.runActivityGroup.mockImplementation(async (group: { id: string }) => {
      if (group.id === storedGroup.id) throw new Error('insert failed');
      return { granted: 0 };
    });
    await expect(run()).rejects.toThrow(`1 group(s) failed: ${storedGroup.id}`);
  });

  // The column ships before anyone defines a milestone in it, and may not be migrated yet.
  it('runs the code groups when stored definitions cannot be read', async () => {
    mocks.loadStoredMilestoneGroups.mockRejectedValue(
      Object.assign(new Error('column "detector" does not exist'), { code: '42703' })
    );
    mocks.runActivityGroup.mockResolvedValue({ granted: 0 });
    await run();
    expect(mocks.runActivityGroup).toHaveBeenCalledTimes(codeGroups().length);
  });

  // A stored query nobody can read in the repo is watched by its timing instead.
  it('reports how long each stored group took, by key alone', async () => {
    mocks.loadStoredMilestoneGroups.mockResolvedValue([storedGroup]);
    mocks.runActivityGroup.mockResolvedValue({ granted: 3 });
    await run();
    expect(storedReports()).toEqual([
      {
        type: 'info',
        name: 'creator-milestone-stored',
        milestoneKey: 'test:x',
        outcome: 'ran',
        ms: expect.any(Number),
      },
    ]);
  });

  // The limits are what keep a stored ClickHouse stage read-only and bounded; they ride on the request.
  it('hands stored groups a ClickHouse reader that sends their settings with the query', async () => {
    await run();
    expect(mocks.loadStoredMilestoneGroups).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ queryClickhouse })
    );
    mocks.clickhouseQuery.mockResolvedValue({ json: async () => [{ id: 1 }] });
    const settings = { readonly: '1', max_execution_time: 5 };
    expect(await queryClickhouse('SELECT 1 AS id', settings)).toEqual([{ id: 1 }]);
    expect(mocks.clickhouseQuery).toHaveBeenCalledWith({
      query: 'SELECT 1 AS id',
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
  });
});
