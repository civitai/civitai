import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Job from '~/server/jobs/job';
import type * as TagsOnImageNew from '~/server/services/tagsOnImageNew.service';

const { mockUpsert } = vi.hoisted(() => ({ mockUpsert: vi.fn() }));

vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof Job>()),
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
  getJobDate: vi.fn().mockResolvedValue([new Date(0), vi.fn()]),
}));
vi.mock('~/server/services/tagsOnImageNew.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagsOnImageNew>()),
  insertTagsOnImageNew: vi.fn(),
  upsertTagsOnImageNew: mockUpsert,
  deleteTagsOnImageNew: vi.fn(),
}));

import { applyVotedTags } from '~/server/jobs/apply-voted-tags';
import { dbMock } from '~/__tests__/mocks/db.mock';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyVotedTags — moderator upvote on a disabled tag', () => {
  it('re-enables the disabled tag, not the newly applied ones', async () => {
    const queries = vi.mocked(dbMock.dbWrite.$queryRaw);
    queries
      .mockResolvedValueOnce([{ imageId: 1, tagId: 11 }] as never) // newly over threshold
      .mockResolvedValueOnce([{ imageId: 2, tagId: 22 }] as never); // disabled, mod-upvoted

    await applyVotedTags.run({} as never);

    expect(mockUpsert).toHaveBeenCalledWith([{ imageId: 2, tagId: 22, disabled: false }]);
    expect(mockUpsert).not.toHaveBeenCalledWith([{ imageId: 1, tagId: 11, disabled: false }]);
  });
});
