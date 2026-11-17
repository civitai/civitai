import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The writes to an image's minor flag, which no trigger watches, each queue the articles whose
 * cover or banner the image is. Rating writes reach the same queue through the image trigger and
 * the update-nsfw-levels job (job-queue-article-cover-reindex.test.ts).
 */

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/services/article-cover-reindex', () => ({
  queueArticlesForCoverImages: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/image-models-reindex.service', () => ({
  queueModelsForImageChildTagChanges: vi.fn(async () => undefined),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { applyIngestionSideEffects, type ScanImage } from '../image-scan-pipeline';
import { toggleImageFlag, updateImagesFlag } from '~/server/services/image.service';
import { queueArticlesForCoverImages } from '~/server/services/article-cover-reindex';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const IMAGE_ID = 88;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a scan result, which writes the minor flag', () => {
  const image = {
    id: IMAGE_ID,
    userId: 2,
    type: 'image',
    metadata: {},
    postId: null,
    nsfwLevel: 4,
    ingestion: ImageIngestionStatus.Scanned,
  } as unknown as ScanImage;

  it('queues the articles the image covers', async () => {
    await applyIngestionSideEffects({
      image,
      outcome: { ingestion: ImageIngestionStatus.Scanned } as Parameters<
        typeof applyIngestionSideEffects
      >[0]['outcome'],
    });
    expect(queueArticlesForCoverImages).toHaveBeenCalledWith([IMAGE_ID]);
  });
});

describe("a moderator's minor flag write", () => {
  it('queues the articles the images cover', async () => {
    await updateImagesFlag({ ids: [IMAGE_ID, 89], flag: 'minor', value: true });
    expect(queueArticlesForCoverImages).toHaveBeenCalledWith([IMAGE_ID, 89]);
  });

  it('queues the articles a toggled image covers', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ minor: false } as never);
    await toggleImageFlag({ id: IMAGE_ID, flag: 'minor' });
    expect(queueArticlesForCoverImages).toHaveBeenCalledWith([IMAGE_ID]);
  });

  it('queues nothing for a poi flag write (control)', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ poi: false } as never);
    await updateImagesFlag({ ids: [IMAGE_ID], flag: 'poi', value: true });
    await toggleImageFlag({ id: IMAGE_ID, flag: 'poi' });
    expect(queueArticlesForCoverImages).not.toHaveBeenCalled();
  });
});
