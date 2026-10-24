import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { getImagesForModelVersionCache, imagesForModelVersionsCache } from '../image.service';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import '~/__tests__/mocks/db.mock';

// Invariant guard, not a regression test: it pins the exact output of
// getImagesForModelVersionCache so a rewrite of how the result is built cannot change it.
// The tag lookup is keyed by the model version ids, and that is pinned as-is.

const image = (id: number, modelVersionId: number, tags: number[]) =>
  ({ id, modelVersionId, url: `url-${id}`, nsfwLevel: id % 7, tags } as never);

const cached = () => ({
  '303': { modelVersionId: 303, images: [] },
  '101': {
    modelVersionId: 101,
    images: [image(11, 101, [1]), image(12, 101, [2, 3])],
  },
  '202': {
    modelVersionId: 202,
    images: [image(21, 202, [4]), image(22, 202, []), image(23, 202, [5])],
  },
});

describe('getImagesForModelVersionCache output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns every cached version with its images and the tags looked up by version id', async () => {
    const fromCache = cached();
    vi.spyOn(imagesForModelVersionsCache, 'fetch').mockResolvedValue(fromCache);
    const tagFetch = vi
      .spyOn(tagIdsForImagesCache, 'fetch')
      .mockResolvedValue({ '202': { imageId: 202, tags: [77, 88] } });

    const result = await getImagesForModelVersionCache([303, 101, 202]);

    expect(tagFetch).toHaveBeenCalledWith([101, 202, 303]);
    expect(Object.keys(result)).toEqual(['101', '202', '303']);
    expect(result).toStrictEqual({
      '101': {
        modelVersionId: 101,
        images: [image(11, 101, [1]), image(12, 101, [2, 3])],
        tags: undefined,
      },
      '202': {
        modelVersionId: 202,
        images: [image(21, 202, [4]), image(22, 202, []), image(23, 202, [5])],
        tags: [77, 88],
      },
      '303': { modelVersionId: 303, images: [], tags: undefined },
    });
    expect(fromCache).toStrictEqual(cached());
  });

  it('returns an empty object when nothing is cached', async () => {
    vi.spyOn(imagesForModelVersionsCache, 'fetch').mockResolvedValue({});
    vi.spyOn(tagIdsForImagesCache, 'fetch').mockResolvedValue({});

    expect(await getImagesForModelVersionCache([404])).toStrictEqual({});
  });
});
