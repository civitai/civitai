import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The writes to an image's minor flag, which no trigger watches, each queue the articles whose
 * cover or banner the image is, and the models whose showcase can hold it. Rating writes reach the
 * article queue through the image trigger and the update-nsfw-levels job
 * (job-queue-article-cover-reindex.test.ts).
 */

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/services/image-models-reindex.service', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
  queueArticlesAndComicsForImages: vi.fn(async () => undefined),
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
import {
  queueArticlesAndComicsForImages,
  queueDocumentsForImageMinorChanges,
} from '~/server/services/image-models-reindex.service';
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

  type Outcome = Parameters<typeof applyIngestionSideEffects>[0]['outcome'];
  const audit = (minor: boolean) => ({ minor, poiTags: [], minorTags: [], reviewTags: [] });

  const scan = (minorBefore: boolean, audited?: boolean) =>
    applyIngestionSideEffects({
      image: { ...image, minor: minorBefore } as ScanImage,
      outcome: {
        ingestion: ImageIngestionStatus.Scanned,
        ...(audited !== undefined && { audit: audit(audited) }),
      } as unknown as Outcome,
    });

  it('queues the articles the image covers', async () => {
    await scan(false);
    expect(queueArticlesAndComicsForImages).toHaveBeenCalledTimes(1);
    expect(queueArticlesAndComicsForImages).toHaveBeenCalledWith([IMAGE_ID]);
  });

  it('queues the models of an image the scan flagged minor, and its articles once', async () => {
    await scan(false, true);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({
      levelImageIds: [IMAGE_ID],
      minorImageIds: [IMAGE_ID],
    });
    // The minorImageIds requeue covers the articles and comics.
    expect(queueArticlesAndComicsForImages).not.toHaveBeenCalled();
  });

  it('🔴 queues the models of an image the scan cleared of minor', async () => {
    await scan(true, false);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({
      levelImageIds: [IMAGE_ID],
      minorImageIds: [IMAGE_ID],
    });
    expect(queueArticlesAndComicsForImages).not.toHaveBeenCalled();
  });

  it.each([
    ['stays unflagged', false, false],
    ['stays flagged', true, true],
  ])('leaves an image whose flag %s to the level path (control)', async (_, before, after) => {
    await scan(before, after);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ levelImageIds: [IMAGE_ID] });
    expect(queueArticlesAndComicsForImages).toHaveBeenCalledTimes(1);
  });
});

describe("a moderator's minor flag write", () => {
  it('queues the models and articles of the images', async () => {
    await updateImagesFlag({ ids: [IMAGE_ID, 89], flag: 'minor', value: true });
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({
      minorImageIds: [IMAGE_ID, 89],
    });
  });

  it('queues the models and articles of a toggled image', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ minor: false } as never);
    await toggleImageFlag({ id: IMAGE_ID, flag: 'minor' });
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ minorImageIds: [IMAGE_ID] });
  });

  it('queues nothing for a poi flag write (control)', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ poi: false } as never);
    await updateImagesFlag({ ids: [IMAGE_ID], flag: 'poi', value: true });
    await toggleImageFlag({ id: IMAGE_ID, flag: 'poi' });
    expect(queueDocumentsForImageMinorChanges).not.toHaveBeenCalled();
    expect(queueArticlesAndComicsForImages).not.toHaveBeenCalled();
  });
});
