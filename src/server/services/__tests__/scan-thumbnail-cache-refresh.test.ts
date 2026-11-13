import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { applyIngestionSideEffects, type ScanImage } from '../image-scan-pipeline';
import { thumbnailCache } from '~/server/redis/caches';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const image = (metadata: Record<string, unknown>) =>
  ({
    id: 77,
    userId: 2,
    type: 'image',
    metadata,
    postId: null,
    nsfwLevel: 4,
    ingestion: ImageIngestionStatus.Scanned,
  } as unknown as ScanImage);

const scanned = { ingestion: ImageIngestionStatus.Scanned } as Parameters<
  typeof applyIngestionSideEffects
>[0]['outcome'];

describe('applyIngestionSideEffects: custom video thumbnails', () => {
  const refresh = vi.spyOn(thumbnailCache, 'refresh');

  beforeEach(() => {
    refresh.mockReset().mockResolvedValue(undefined as never);
  });

  it('refreshes the parent video’s entry once the thumbnail’s final level is written', async () => {
    await applyIngestionSideEffects({ image: image({ parentId: 500 }), outcome: scanned });

    expect(refresh).toHaveBeenCalledWith(500);
  });

  it('leaves the thumbnail cache alone for an image that is not a thumbnail', async () => {
    await applyIngestionSideEffects({ image: image({}), outcome: scanned });

    expect(refresh).not.toHaveBeenCalled();
  });
});
