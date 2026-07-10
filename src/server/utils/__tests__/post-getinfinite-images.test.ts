import { describe, expect, it } from 'vitest';
import {
  POST_GETINFINITE_IMAGES_PER_POST,
  capPostGetInfiniteImages,
  stripPostGetInfiniteImageFields,
} from '~/server/utils/post-getinfinite-images';

// The browse-feed (`post.getInfinite`) response caps each post's embedded images
// to the first few, because the browse post cards render only `images[0]` (the
// cover) and read the separate `imageCount` field (computed from the FULL list)
// for the count. `getImagesForPosts` returns the post's ENTIRE image list, so a
// gallery post bloats the tRPC payload (serialized synchronously on the event
// loop). The cap keeps leading order (cover stays `images[0]`), keeps headroom
// for the client hidden-preferences fall-through, and MUST NOT mutate its input.

const makeImages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, url: `img-${i + 1}` }));

describe('post-getinfinite-images', () => {
  it('caps to at most POST_GETINFINITE_IMAGES_PER_POST', () => {
    // Pinned: the browse cap is 8 (headroom over the single rendered cover image
    // for the client hidden-preferences fall-through — see the constant's doc).
    expect(POST_GETINFINITE_IMAGES_PER_POST).toBe(8);
    const out = capPostGetInfiniteImages(makeImages(50));
    expect(out.length).toBe(POST_GETINFINITE_IMAGES_PER_POST);
  });

  it('keeps the leading images in order (browse cards read images[0])', () => {
    const images = makeImages(50);
    const out = capPostGetInfiniteImages(images);
    expect(out.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // identity preserved (not re-cloned) so downstream `images[0]` is the same ref
    expect(out[0]).toBe(images[0]);
  });

  it('returns everything when there are fewer than the cap (typical posts untouched)', () => {
    expect(capPostGetInfiniteImages(makeImages(3)).length).toBe(3);
    expect(capPostGetInfiniteImages(makeImages(1)).length).toBe(1);
    expect(capPostGetInfiniteImages([])).toEqual([]);
  });

  it('does NOT mutate the source array', () => {
    const source = makeImages(50);
    const before = [...source];
    const out = capPostGetInfiniteImages(source);
    expect(source).toHaveLength(50);
    expect(source).toEqual(before);
    expect(out).not.toBe(source); // a new array, not the same reference
  });
});

describe('stripPostGetInfiniteImageFields', () => {
  // A representative post.getInfinite image row: the server-only grouping field
  // `postId` alongside the fields consumers DO read (cover render +
  // hidden-preferences filter).
  const makeRow = (id: number) => ({
    id,
    postId: 999,
    userId: 42,
    url: `url-${id}`,
    name: `img-${id}`,
    nsfwLevel: 1,
    width: 512,
    height: 512,
    hash: 'abc',
    type: 'image',
    metadata: { width: 512, height: 512 },
    onSite: true,
    remixOfId: null,
    poi: false,
    minor: false,
    tagIds: [1, 2, 3],
  });

  it('drops postId from every image', () => {
    const out = stripPostGetInfiniteImageFields([makeRow(1), makeRow(2)]);
    expect(out).toHaveLength(2);
    for (const img of out) {
      expect('postId' in img).toBe(false);
    }
  });

  it('preserves every field a consumer reads (cover render + hidden-preferences)', () => {
    const [out] = stripPostGetInfiniteImageFields([makeRow(7)]);
    // cover render path (PostsCard / PostCard / EdgeMedia2 / MediaHash / OnsiteIndicator)
    for (const key of [
      'id',
      'url',
      'name',
      'nsfwLevel',
      'width',
      'height',
      'hash',
      'type',
      'metadata',
      'onSite',
      'remixOfId',
    ]) {
      expect(out).toHaveProperty(key);
    }
    // hidden-preferences filter (useApplyHiddenPreferences, posts path)
    for (const key of ['id', 'userId', 'nsfwLevel', 'tagIds', 'poi', 'minor']) {
      expect(out).toHaveProperty(key);
    }
    expect(out.url).toBe('url-7');
    expect(out.tagIds).toEqual([1, 2, 3]);
  });

  it('returns NEW objects and does not mutate the input', () => {
    const source = [makeRow(1)];
    const out = stripPostGetInfiniteImageFields(source);
    expect(out[0]).not.toBe(source[0]);
    expect('postId' in source[0]).toBe(true); // input untouched
  });

  it('handles an empty array', () => {
    expect(stripPostGetInfiniteImageFields([])).toEqual([]);
  });
});
