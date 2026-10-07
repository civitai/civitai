import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  runActivityGroup: vi.fn(),
}));

vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  dbWrite: {
    keyValue: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        mocks.kv.has(where.key) ? { key: where.key, value: mocks.kv.get(where.key) } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) => mocks.kv.set(where.key, mocks.kv.has(where.key) ? update.value : create.value),
    },
  },
}));
vi.mock('~/server/services/creator-milestone-activity.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ActivityService>()),
  runActivityGroup: mocks.runActivityGroup,
}));

import type * as DbClient from '~/server/db/client';
import type * as ActivityService from '~/server/services/creator-milestone-activity.service';
import {
  grantCreatorMilestones,
  keyValueWatermarkStore,
  memoizedAudience,
} from '~/server/jobs/grant-creator-milestones';
import { activityDetectorGroups } from '~/server/services/creator-milestone-detectors';

beforeEach(() => {
  mocks.kv.clear();
  mocks.runActivityGroup.mockReset();
});

// The production store is what decides whether a watermark exists. A get that invents one announces
// every publish since launch; a round trip that loses it silences every run for good.
describe('keyValueWatermarkStore', () => {
  it('reads back what it wrote', async () => {
    await keyValueWatermarkStore.set('k', { at: 1234, gated: false });
    expect(await keyValueWatermarkStore.get('k')).toEqual({ at: 1234, gated: false });
  });

  it.each([
    ['a missing row', undefined],
    ['a bare job-date number', 1234],
    ['a stringly time', { at: '1234', gated: false }],
    ['no gated flag', { at: 1234 }],
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
  const run = () =>
    grantCreatorMilestones.run({} as never).result as Promise<Record<string, unknown> | undefined>;

  it('runs every group even when one fails, then fails the run naming it', async () => {
    const groups = activityDetectorGroups();
    mocks.runActivityGroup.mockImplementation(async (group: { id: string }) => {
      if (group.id === groups[0].id) throw new Error('boom');
      return { granted: 0 };
    });
    await expect(run()).rejects.toThrow(`1 group(s) failed: ${groups[0].id}`);
    expect(mocks.runActivityGroup.mock.calls.map(([group]) => group.id)).toEqual(
      groups.map((group) => group.id)
    );
  });
});
