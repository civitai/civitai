import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
// FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));

import { getImagesForModelVersionCache, imagesForModelVersionsCache } from '../image.service';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import '~/__tests__/mocks/db.mock';

const flag = vi.mocked(isFlipt);

// With `model-version-images-skip-tags` OFF this is an invariant guard: it pins the exact output
// of getImagesForModelVersionCache, including the tag lookup keyed by the model version ids,
// as-is. With it ON the lookup is skipped and no entry carries `tags`.

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

describe('getImagesForModelVersionCache output (flag off)', () => {
  beforeEach(() => {
    // restoreAllMocks keeps a vi.fn's call history; clear it so each test sees only its own calls.
    flag.mockClear();
    flag.mockResolvedValue(false);
  });
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

    expect(flag).toHaveBeenCalledWith(FLIPT_FEATURE_FLAGS.MODEL_VERSION_IMAGES_SKIP_TAGS);
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

describe('getImagesForModelVersionCache output (model-version-images-skip-tags on)', () => {
  beforeEach(() => {
    // restoreAllMocks keeps a vi.fn's call history; clear it so each test sees only its own calls.
    flag.mockClear();
    flag.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the tag lookup and returns every cached version without entry-level tags', async () => {
    const fromCache = cached();
    vi.spyOn(imagesForModelVersionsCache, 'fetch').mockResolvedValue(fromCache);
    const tagFetch = vi
      .spyOn(tagIdsForImagesCache, 'fetch')
      .mockResolvedValue({ '202': { imageId: 202, tags: [77, 88] } });

    const result = await getImagesForModelVersionCache([303, 101, 202]);

    expect(flag).toHaveBeenCalledWith('model-version-images-skip-tags');
    expect(tagFetch).not.toHaveBeenCalled();
    expect(result).toStrictEqual(cached());
    for (const entry of Object.values(result)) expect('tags' in entry).toBe(false);
    // Fresh top-level entry objects (a shallow copy: each entry's `images` array is still shared).
    expect(result[101]).not.toBe(fromCache['101']);
    expect(fromCache).toStrictEqual(cached());
  });
});
