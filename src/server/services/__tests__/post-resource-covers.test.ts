import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `attachPostResourceCovers` reads every version's cover from the shared version-image cache in
 * one batched call. The cache already drops unpublished, blocked and unreviewed images.
 */

const { mockFetchCovers } = vi.hoisted(() => ({ mockFetchCovers: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesForModelVersionsCache: { fetch: mockFetchCovers },
}));

import { attachPostResourceCovers } from '~/server/services/post.service';

const cached = (id: number, versionId: number) => ({
  id,
  userId: 5,
  name: 'private-name',
  url: `url-${id}`,
  type: 'image',
  nsfwLevel: 4,
  width: 512,
  height: 768,
  hash: `hash-${id}`,
  modelVersionId: versionId,
  availability: 'Public',
  metadata: { secret: true },
  poi: false,
  minor: false,
});

beforeEach(() => {
  mockFetchCovers.mockReset().mockResolvedValue({
    1: { modelVersionId: 1, images: [cached(11, 1), cached(12, 1)] },
    3: { modelVersionId: 3, images: [] },
  });
});

describe('attachPostResourceCovers', () => {
  it('reads every version in one cache call and attaches the first image as the cover', async () => {
    const rows = await attachPostResourceCovers([
      { modelVersionId: 1, name: 'lora' },
      { modelVersionId: 3, name: 'checkpoint' },
      { modelVersionId: 1, name: 'lora again' },
    ]);

    expect(mockFetchCovers).toHaveBeenCalledTimes(1);
    expect(mockFetchCovers).toHaveBeenCalledWith([1, 3]);
    expect(rows[0]).toEqual({
      modelVersionId: 1,
      name: 'lora',
      coverImage: {
        id: 11,
        userId: 5,
        url: 'url-11',
        type: 'image',
        nsfwLevel: 4,
        width: 512,
        height: 768,
        hash: 'hash-11',
        poi: false,
        minor: false,
      },
    });
    expect(rows[2].coverImage?.id).toBe(11);
  });

  it('gives null to a version with no cover or no cache entry', async () => {
    mockFetchCovers.mockResolvedValue({ 1: { modelVersionId: 1, images: [] } });

    const rows = await attachPostResourceCovers([{ modelVersionId: 1 }, { modelVersionId: 3 }]);

    expect(rows.map((r) => r.coverImage)).toEqual([null, null]);
  });

  it('still returns the rows, without covers, when the cache fails', async () => {
    mockFetchCovers.mockRejectedValue(new Error('redis down'));

    const rows = await attachPostResourceCovers([{ modelVersionId: 1, name: 'lora' }]);

    expect(rows).toEqual([{ modelVersionId: 1, name: 'lora', coverImage: null }]);
  });

  it('skips the cache when there are no rows', async () => {
    expect(await attachPostResourceCovers([])).toEqual([]);
    expect(mockFetchCovers).not.toHaveBeenCalled();
  });
});
