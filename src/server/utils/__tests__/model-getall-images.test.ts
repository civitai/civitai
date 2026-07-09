import { describe, expect, it } from 'vitest';
import {
  GET_ALL_IMAGES_PER_MODEL,
  capGetAllModelImages,
} from '~/server/utils/model-getall-images';

// The browse-feed (`model.getAll`) response caps each model's images to the first
// few, because the browse `ModelCard` renders only `images[0]`. The shared image
// cache (`imagesForModelVersionsCache`) still holds the full 20 for model-detail /
// auction consumers, so the cap MUST NOT mutate the array it is given (a getAll
// entry can alias a shared-cache array when no `excludedTagIds` filter runs).

const makeImages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, url: `img-${i + 1}` }));

describe('model-getall-images', () => {
  it('caps to at most GET_ALL_IMAGES_PER_MODEL', () => {
    expect(GET_ALL_IMAGES_PER_MODEL).toBeLessThanOrEqual(3);
    const out = capGetAllModelImages(makeImages(20));
    expect(out.length).toBe(GET_ALL_IMAGES_PER_MODEL);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('keeps the leading images in order (browse UI reads images[0])', () => {
    const images = makeImages(20);
    const out = capGetAllModelImages(images);
    expect(out.map((x) => x.id)).toEqual([1, 2, 3]);
    // identity preserved (not re-cloned) so downstream `images[0]` is the same ref
    expect(out[0]).toBe(images[0]);
  });

  it('returns everything when there are fewer than the cap', () => {
    expect(capGetAllModelImages(makeImages(2)).length).toBe(2);
    expect(capGetAllModelImages(makeImages(1)).length).toBe(1);
    expect(capGetAllModelImages([])).toEqual([]);
  });

  it('does NOT mutate the source array (shared-cache safety)', () => {
    // Simulates slicing a value that aliases a shared `imagesForModelVersionsCache`
    // entry: the cache must still hold all 20 images afterwards.
    const cached = makeImages(20);
    const before = [...cached];
    const out = capGetAllModelImages(cached);
    expect(cached).toHaveLength(20);
    expect(cached).toEqual(before);
    expect(out).not.toBe(cached); // a new array, not the same reference
  });
});
