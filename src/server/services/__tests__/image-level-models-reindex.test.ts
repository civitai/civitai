import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
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
import { resolveIngestionError } from '~/server/services/image.service';
import { queueModelsForImageChildTagChanges } from '~/server/services/image-models-reindex.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const IMAGE_ID = 88;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyIngestionSideEffects: models index', () => {
  const image = (postId: number | null) =>
    ({
      id: IMAGE_ID,
      userId: 2,
      type: 'image',
      metadata: {},
      postId,
      nsfwLevel: 4,
      ingestion: ImageIngestionStatus.Scanned,
    } as unknown as ScanImage);
  const scanned = { ingestion: ImageIngestionStatus.Scanned } as Parameters<
    typeof applyIngestionSideEffects
  >[0]['outcome'];

  it('hands a scanned post image over as re-rated', async () => {
    await applyIngestionSideEffects({ image: image(10), outcome: scanned });

    expect(queueModelsForImageChildTagChanges).toHaveBeenCalledWith({ levelImageIds: [IMAGE_ID] });
  });

  it('skips an image on no post', async () => {
    await applyIngestionSideEffects({ image: image(null), outcome: scanned });

    expect(queueModelsForImageChildTagChanges).not.toHaveBeenCalled();
  });
});

describe('resolveIngestionError: models index', () => {
  const arm = (postId: number | null) => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ingestion: 'Error',
      postId,
      userId: 99,
      metadata: {},
      url: 'https://example.com/legacy.jpeg',
      blockedFor: null,
      needsReview: null,
      user: { bannedAt: null, deletedAt: null },
    } as never);
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 1 } as never);
  };

  it('hands the re-rated post image over', async () => {
    arm(10);

    await resolveIngestionError({ id: IMAGE_ID, nsfwLevel: 8, userId: 7 });

    expect(queueModelsForImageChildTagChanges).toHaveBeenCalledWith({ levelImageIds: [IMAGE_ID] });
  });

  it('skips an image on no post', async () => {
    arm(null);

    await resolveIngestionError({ id: IMAGE_ID, nsfwLevel: 8, userId: 7 });

    expect(queueModelsForImageChildTagChanges).not.toHaveBeenCalled();
  });
});
