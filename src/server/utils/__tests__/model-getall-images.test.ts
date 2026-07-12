import { describe, expect, it } from 'vitest';
import {
  buildGetAllModelImages,
  capGetAllModelImages,
  GET_ALL_IMAGES_PER_MODEL,
  GET_ALL_IMAGES_PER_MODEL_SLIM,
  GETALL_DROPPED_IMAGE_FIELDS,
  stripGetAllModelImage,
} from '~/server/utils/model-getall-images';

// The browse-feed (`model.getAll`) response is the #1 serialize-freeze source.
// Its image trim has two parts: an ALWAYS-ON per-image field drop
// (`stripGetAllModelImage`) and a FLAG-GATED count cap (`capGetAllModelImages`,
// 12 default / 6 slim). Both are applied by `buildGetAllModelImages`. The shared
// image cache (`imagesForModelVersionsCache`) still holds the full 20 with all
// fields for model-detail / auction / carousel consumers, so neither step may
// mutate the array or the image objects it is given (a getAll entry can alias a
// shared-cache array when no `excludedTagIds` filter runs).

const makeImages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, url: `img-${i + 1}` }));

// A full-fidelity image as it comes off `imagesForModelVersionsCache`.
const makeFullImage = (id: number) => ({
  id,
  userId: 100 + id,
  name: `img-${id}.png`,
  url: `url-${id}`,
  nsfwLevel: 1,
  width: 1024,
  height: 1536,
  hash: `hash-${id}`,
  type: 'image' as const,
  metadata: { width: 1024, height: 1536, hash: `hash-${id}` },
  minor: false,
  poi: false,
  modelVersionId: 999,
  availability: 'Public' as const,
  hasMeta: true,
  hasPositivePrompt: true,
  onSite: false,
  remixOfId: null,
  tags: [1, 2, 3],
});

describe('model-getall-images — cap', () => {
  it('pins the default (12) and slim (6) caps', () => {
    // Default raised 3 → 8 → 12 across the browsing-level feed-drop reviews; slim
    // is the flag-gated material lever. See the constant docs.
    expect(GET_ALL_IMAGES_PER_MODEL).toBe(12);
    expect(GET_ALL_IMAGES_PER_MODEL_SLIM).toBe(6);
    expect(GET_ALL_IMAGES_PER_MODEL_SLIM).toBeLessThan(GET_ALL_IMAGES_PER_MODEL);
  });

  it('caps to at most the default limit', () => {
    expect(capGetAllModelImages(makeImages(20))).toHaveLength(GET_ALL_IMAGES_PER_MODEL);
  });

  it('caps to the slim limit when passed', () => {
    const out = capGetAllModelImages(makeImages(20), GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps the leading images in order (browse UI reads the leading cover)', () => {
    const images = makeImages(20);
    const out = capGetAllModelImages(images);
    expect(out.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(out[0]).toBe(images[0]); // identity preserved
  });

  it('returns everything when there are fewer than the cap', () => {
    expect(capGetAllModelImages(makeImages(2))).toHaveLength(2);
    expect(capGetAllModelImages([])).toEqual([]);
  });

  it('does NOT mutate the source array (shared-cache safety)', () => {
    const cached = makeImages(20);
    const before = [...cached];
    const out = capGetAllModelImages(cached);
    expect(cached).toHaveLength(20);
    expect(cached).toEqual(before);
    expect(out).not.toBe(cached);
  });
});

describe('model-getall-images — field strip', () => {
  it('drops EXACTLY the unread fields and keeps everything a consumer reads', () => {
    const img = makeFullImage(1);
    const stripped = stripGetAllModelImage(img) as Record<string, unknown>;

    for (const dropped of GETALL_DROPPED_IMAGE_FIELDS) {
      expect(stripped, `should drop ${dropped}`).not.toHaveProperty(dropped);
    }
    // The keep-set: filter fields (all images) + render fields (the cover).
    for (const kept of [
      'id',
      'userId',
      'nsfwLevel',
      'tags',
      'poi',
      'minor',
      'url',
      'name',
      'type',
      'hash',
      'width',
      'height',
      'metadata',
      'remixOfId',
    ]) {
      expect(stripped, `should keep ${kept}`).toHaveProperty(kept);
    }
  });

  it('the drop set is exactly the 5 verified-unread fields', () => {
    expect([...GETALL_DROPPED_IMAGE_FIELDS].sort()).toEqual(
      ['availability', 'hasMeta', 'hasPositivePrompt', 'modelVersionId', 'onSite'].sort()
    );
  });

  it('does NOT mutate the input image (shared-cache safety)', () => {
    const img = makeFullImage(1);
    const snapshot = JSON.stringify(img);
    stripGetAllModelImage(img);
    expect(JSON.stringify(img)).toBe(snapshot);
    // nested references are shared (not deep-cloned) but never mutated
    expect(stripGetAllModelImage(img).metadata).toBe(img.metadata);
  });
});

describe('model-getall-images — buildGetAllModelImages (cap + strip)', () => {
  it('caps then field-trims (default limit)', () => {
    const out = buildGetAllModelImages(Array.from({ length: 20 }, (_, i) => makeFullImage(i + 1)));
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL);
    for (const dropped of GETALL_DROPPED_IMAGE_FIELDS) {
      expect(out[0]).not.toHaveProperty(dropped);
    }
    expect(out[0]).toHaveProperty('url');
  });

  it('slim limit reduces the count (flag-on path)', () => {
    const out = buildGetAllModelImages(
      Array.from({ length: 20 }, (_, i) => makeFullImage(i + 1)),
      GET_ALL_IMAGES_PER_MODEL_SLIM
    );
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL_SLIM);
  });

  it('returns a fresh array of fresh objects (never the cache refs)', () => {
    const cached = Array.from({ length: 20 }, (_, i) => makeFullImage(i + 1));
    const out = buildGetAllModelImages(cached);
    expect(out).not.toBe(cached);
    expect(out[0]).not.toBe(cached[0]);
    expect(cached).toHaveLength(20); // cache untouched
    expect(cached[0]).toHaveProperty('onSite'); // cache still full-fidelity
  });
});
