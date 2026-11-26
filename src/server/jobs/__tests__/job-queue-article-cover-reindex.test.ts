import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every write to Image."nsfwLevel", from any app, lands in update-nsfw-levels through the image
 * trigger (`image_nsfw_level_change`). That job hands the images to queueArticlesAndComicsForImages, so an
 * article's search document follows its cover's rating even when the article's own level holds.
 */

const { queueArticlesAndComicsForImages } = vi.hoisted(() => ({
  queueArticlesAndComicsForImages: vi.fn(async (_imageIds: number[]) => undefined),
}));
vi.mock('~/server/services/image-models-reindex.service', () => ({
  queueArticlesAndComicsForImages,
}));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  getNsfwLevelRelatedEntities: vi.fn(async () => ({
    postIds: [],
    articleIds: [],
    bountyIds: [],
    bountyEntryIds: [],
    modelVersionIds: [],
    modelIds: [],
    collectionIds: [],
    comicProjectIds: [],
    model3dIds: [],
    serviceOfferingIds: [],
  })),
  updateNsfwLevels: vi.fn(async () => undefined),
  updateCollectionsNsfwLevels: vi.fn(async () => []),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { jobQueueJobs } from '~/server/jobs/job-queue';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

const job = jobQueueJobs.find((j) => j.name === 'update-nsfw-levels')!;
const runJob = () => job.run({} as Parameters<typeof job.run>[0]).result;

const queue = (rows: [number, EntityType][]) =>
  dbMock.dbRead.jobQueue.findMany.mockResolvedValue(
    rows.map(([entityId, entityType]) => ({
      entityId,
      entityType,
      type: JobQueueType.UpdateNsfwLevel,
      createdAt: new Date(),
    })) as never
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('update-nsfw-levels: article covers', () => {
  it('hands the re-rated images to the article cover reindex', async () => {
    queue([
      [501, EntityType.Image],
      [502, EntityType.Image],
      [9, EntityType.Post],
    ]);
    await runJob();
    expect(queueArticlesAndComicsForImages).toHaveBeenCalledWith([501, 502]);
  });

  it('hands over no images when none were re-rated (control)', async () => {
    queue([[9, EntityType.Post]]);
    await runJob();
    const ids = queueArticlesAndComicsForImages.mock.calls.flatMap((call) => call[0]);
    expect(ids).toEqual([]);
  });
});
