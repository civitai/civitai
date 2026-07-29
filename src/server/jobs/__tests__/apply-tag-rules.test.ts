import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * apply-tag-rules is an automated 5-min job that adds/removes model tags directly on
 * TagsOnModels. Because ModelTag gives every TagsOnModels row a base score of 5, both
 * directions change a model's votable-tags list — so the job must bust
 * modelVotableTagsCache for the affected models (else ≤TTL staleness after each run).
 * This pins that contract.
 */

const { mockDbWrite, mockBust, mockGetTagRules } = vi.hoisted(() => ({
  mockDbWrite: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
  },
  mockBust: vi.fn(),
  mockGetTagRules: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/redis/caches', () => ({ modelVotableTagsCache: { bust: mockBust } }));
vi.mock('~/server/services/system-cache', () => ({ getTagRules: mockGetTagRules }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
  getJobDate: vi.fn().mockResolvedValue([new Date(0), vi.fn()]),
}));

import { applyTagRules } from '~/server/jobs/apply-tag-rules';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.$executeRaw.mockResolvedValue(undefined);
});

describe('applyTagRules — votable-tags cache invalidation', () => {
  it('busts the model cache for both inserted and deleted models on a Replace rule', async () => {
    mockGetTagRules.mockResolvedValue([
      { fromId: 1, toId: 2, fromTag: 'a', toTag: 'b', type: 'Replace', createdAt: new Date() },
    ]);
    // $queryRaw call order: MAX(image id), then appendTag models INSERT..RETURNING, then
    // deleteTag models DELETE..RETURNING.
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([{ id: 100 }]) // MAX image id
      .mockResolvedValueOnce([{ modelId: 7 }, { modelId: 9 }]) // inserted models
      .mockResolvedValueOnce([{ modelId: 8 }]); // deleted models

    await applyTagRules.run({});

    expect(mockBust).toHaveBeenCalledWith([7, 9]);
    expect(mockBust).toHaveBeenCalledWith([8]);
    expect(mockBust).toHaveBeenCalledTimes(2);
  });

  it('does not bust when an Append rule touches no models', async () => {
    mockGetTagRules.mockResolvedValue([
      { fromId: 1, toId: 2, fromTag: 'a', toTag: 'b', type: 'Append', createdAt: new Date() },
    ]);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([{ id: 100 }]) // MAX image id
      .mockResolvedValueOnce([]); // inserted models — none

    await applyTagRules.run({});

    expect(mockBust).not.toHaveBeenCalled();
  });
});
