import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The general safety net for collection documents going stale.
 *
 * A row trigger on `CollectionItem` (`collection_nsfw_level_change`) writes a deduped
 * `JobQueue` row for the collection on every insert, delete and status change. Row
 * triggers fire on FK cascades, so this is the one place that sees EVERY membership
 * change — including the raw-SQL and `deleteMany` paths that no per-call-site enqueue
 * will ever cover.
 *
 * The search-index enqueue this job already made went through
 * `updateCollectionsNsfwLevels`, which returns only the collections whose level
 * actually moved (`AND c."nsfwLevel" != c2."nsfwLevel"`). Removing an item rarely moves
 * an aggregate level, so that set was almost always empty and the document was never
 * rebuilt. The queue row is the signal; the level change is not.
 */

const { mockCollectionsQueueUpdate, mockUpdateCollectionsNsfwLevels } = vi.hoisted(() => ({
  mockCollectionsQueueUpdate: vi.fn(),
  mockUpdateCollectionsNsfwLevels: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateCollectionsNsfwLevels: mockUpdateCollectionsNsfwLevels,
  updateArticleNsfwLevels: vi.fn(),
  updateBountyNsfwLevels: vi.fn(),
  updateBountyEntryNsfwLevels: vi.fn(),
  updateModelNsfwLevels: vi.fn(),
  updateModelVersionNsfwLevels: vi.fn(),
  updatePostNsfwLevels: vi.fn(),
  updateModel3dNsfwLevels: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { jobQueueJobs } from '~/server/jobs/job-queue';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const COLLECTION_A = 8801;
const COLLECTION_B = 9107;
const COLLECTION_C = 7743;

const job = jobQueueJobs.find((j) => j.name === 'update-nsfw-levels-collections')!;
const runJob = () => job.run({} as Parameters<typeof job.run>[0]).result;

const queuedIds = () =>
  mockCollectionsQueueUpdate.mock.calls.flatMap((c) => (c[0] as { id: number }[]).map((x) => x.id));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.jobQueue.findMany.mockResolvedValue(
    [COLLECTION_A, COLLECTION_B, COLLECTION_C].map((entityId) => ({
      entityId,
      entityType: EntityType.Collection,
      type: JobQueueType.UpdateNsfwLevel,
      createdAt: new Date(),
    }))
  );
  dbMock.dbWrite.jobQueue.deleteMany.mockResolvedValue({ count: 3 });
});

describe('update-nsfw-levels-collections', () => {
  it('queues a search-index rebuild for every queued collection, not only ones whose level moved', async () => {
    // The common case: membership changed, the aggregate level did not.
    mockUpdateCollectionsNsfwLevels.mockResolvedValue([]);

    await runJob();

    expect(queuedIds().sort()).toEqual([COLLECTION_A, COLLECTION_B, COLLECTION_C].sort());
  });

  it('queues them as Update, never Delete', async () => {
    // A collection that lost its last item still exists; #4679's pull decides whether
    // its document survives. A Delete here would evict a live collection.
    mockUpdateCollectionsNsfwLevels.mockResolvedValue([]);

    await runJob();

    const actions = mockCollectionsQueueUpdate.mock.calls.flatMap((c) =>
      (c[0] as { action: string }[]).map((x) => x.action)
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(new Set(actions)).toEqual(new Set([SearchIndexUpdateQueueAction.Update]));
  });

  it('tells the index even when the nsfw recompute throws', async () => {
    // The recompute is the fragile half — two EXISTS subqueries over four LEFT JOINs
    // per collection, against collections of up to ~191k items — and the per-batch
    // catch swallows its failure. Ordered after the enqueue, a batch that fails every
    // run would never reach the index at all.
    mockUpdateCollectionsNsfwLevels.mockRejectedValue(new Error('statement timeout'));

    await runJob();

    expect(queuedIds().sort()).toEqual([COLLECTION_A, COLLECTION_B, COLLECTION_C].sort());
    // The rows stay queued, so the collection is retried rather than dropped.
    expect(dbMock.dbWrite.jobQueue.deleteMany).not.toHaveBeenCalled();
  });

  it('still updates the nsfw levels it was queued for', async () => {
    mockUpdateCollectionsNsfwLevels.mockResolvedValue([]);

    await runJob();

    expect(mockUpdateCollectionsNsfwLevels).toHaveBeenCalledWith(
      expect.arrayContaining([COLLECTION_A, COLLECTION_B, COLLECTION_C])
    );
  });

  it('clears the queue rows it processed', async () => {
    mockUpdateCollectionsNsfwLevels.mockResolvedValue([]);

    await runJob();

    // Without this the job reprocesses the same rows every run, forever.
    expect(dbMock.dbWrite.jobQueue.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityId: { in: expect.arrayContaining([COLLECTION_A]) },
        }),
      })
    );
  });

  it('enqueues nothing when the queue is empty', async () => {
    dbMock.dbRead.jobQueue.findMany.mockResolvedValue([]);

    await runJob();

    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });
});
