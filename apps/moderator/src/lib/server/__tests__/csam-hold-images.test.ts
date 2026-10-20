import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPostHoldImages, getCsamHoldRef, getModelPreview } = vi.hoisted(() => ({
  getPostHoldImages: vi.fn(),
  getCsamHoldRef: vi.fn(),
  getModelPreview: vi.fn(),
}));

vi.mock('../csam-holds.queries', () => ({ getPostHoldImages, getCsamHoldRef }));
vi.mock('../model-preview.service', () => ({ getModelPreview }));
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const { getHoldImages, getHoldImagesById } = await import('../csam-holds.service');

const still = (id: number) => ({ id, url: `k-${id}`, type: 'image', nsfwLevel: 1, blocked: false });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getHoldImages', () => {
  it('shows the first four pictures of a held post and its true count', async () => {
    const images = [1, 2, 3, 4].map((id) => ({ id, url: `k-${id}`, nsfwLevel: 1 }));
    getPostHoldImages.mockResolvedValue({ images, total: 9 });
    expect(await getHoldImages({ entityType: 'Post', entityId: 5 })).toEqual({
      images,
      total: 9,
      atLeast: false,
    });
    expect(getPostHoldImages).toHaveBeenCalledWith(5, 4);
  });

  it("shows a held model's showcase stills, leaving out videos, and says when there are more", async () => {
    getModelPreview.mockResolvedValue({
      images: [still(1), { ...still(2), type: 'video' }, still(3), still(4), still(5), still(6)],
      moreImages: true,
    });
    const found = await getHoldImages({ entityType: 'Model', entityId: 7 });
    expect(found?.images.map((i) => i.id)).toEqual([1, 3, 4, 5]);
    expect(found).toMatchObject({ total: 5, atLeast: true });
    expect(found?.images[0]).toEqual({ id: 1, url: 'k-1', nsfwLevel: 1 });
  });

  it.each(['ChatMessage', 'Comment', 'CommentV2', 'UserProfile'])(
    'has none for %s',
    async (type) => {
      expect(await getHoldImages({ entityType: type, entityId: 1 })).toBeNull();
      expect(getPostHoldImages).not.toHaveBeenCalled();
    }
  );

  it('has none when the post or model has no pictures or is gone', async () => {
    getPostHoldImages.mockResolvedValue({ images: [], total: 0 });
    expect(await getHoldImages({ entityType: 'Post', entityId: 5 })).toBeNull();
    getModelPreview.mockResolvedValue(null);
    expect(await getHoldImages({ entityType: 'Model', entityId: 7 })).toBeNull();
  });
});

describe('getHoldImagesById', () => {
  it('has none for an id that is not a csam hold', async () => {
    getCsamHoldRef.mockResolvedValue(null);
    expect(await getHoldImagesById(3)).toBeNull();
  });
});
