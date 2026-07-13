import { describe, expect, it } from 'vitest';
import {
  buildGetAllModelImages,
  capGetAllModelImages,
  GET_ALL_IMAGES_PER_MODEL,
  GET_ALL_IMAGES_PER_MODEL_SLIM,
  GETALL_DROPPED_IMAGE_FIELDS,
  selectSlimGetAllModelImages,
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

// -----------------------------------------------------------------------------
// NSFW-biased slim slice (`selectSlimGetAllModelImages`) — the flag-ON selection.
// An image `nsfwLevel` is ALWAYS a single bit (1/2/4/8/16/32 — ≤6 distinct levels),
// which is what makes "one representative per distinct bit" a provable near-zero
// feed-drop guarantee for BOTH client-filter nsfw branches:
//   - model.nsfw    → keep if `nsfwLevel <= maxSelectedLevel`
//   - otherwise     → keep if `(nsfwLevel & browsingLevel) != 0`
// -----------------------------------------------------------------------------
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const XXX = 16;
const BLOCKED = 32;

// Build a per-model image array from a list of (single-bit) nsfwLevels, index-ordered
// as the shared `postId,index` cache would deliver them.
const makeLeveled = (levels: number[]) =>
  levels.map((nsfwLevel, i) => ({ id: i + 1, url: `img-${i + 1}`, nsfwLevel }));

// The two per-image nsfw filter branches, mirrored from useApplyHiddenPreferences
// `case 'models'`. Returns whether ANY image in the set is visible to the viewer.
const anyVisibleBrowsing = (imgs: { nsfwLevel: number }[], browsingLevel: number) =>
  imgs.some((i) => (i.nsfwLevel & browsingLevel) !== 0);
const anyVisibleMaxLevel = (imgs: { nsfwLevel: number }[], maxSelectedLevel: number) =>
  imgs.some((i) => i.nsfwLevel <= maxSelectedLevel);

describe('model-getall-images — nsfw-biased slim slice', () => {
  it('(a) always contains images[0] (the curated lead)', () => {
    const imgs = makeLeveled([XXX, XXX, XXX, XXX, XXX, XXX, PG, PG13, R, X]);
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out[0]).toBe(imgs[0]);
  });

  it('(a2) keeps images[0] even when its nsfwLevel is unset', () => {
    const imgs = [
      { id: 1, url: 'lead', nsfwLevel: undefined as number | undefined },
      ...makeLeveled([XXX, XXX, XXX, XXX, XXX, PG, R]).map((x) => ({ ...x, id: x.id + 1 })),
    ];
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out).toContain(imgs[0]);
  });

  it('(b) contains ≥1 image of EVERY distinct nsfwLevel present (coverage property)', () => {
    // 5 distinct bits scattered past the naive-first-6 window.
    const imgs = makeLeveled([XXX, XXX, XXX, XXX, XXX, XXX, R, PG13, PG, X, XXX, XXX]);
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    const distinct = new Set(imgs.map((i) => i.nsfwLevel));
    const covered = new Set(out.map((i) => i.nsfwLevel));
    for (const level of distinct) expect(covered.has(level)).toBe(true);
  });

  it('(b2) covers all 6 distinct bits when exactly 6 are present', () => {
    const imgs = makeLeveled([XXX, XXX, XXX, XXX, XXX, XXX, PG, PG13, R, X, XXX, BLOCKED]);
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(new Set(out.map((i) => i.nsfwLevel))).toEqual(
      new Set([PG, PG13, R, X, XXX, BLOCKED])
    );
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL_SLIM);
  });

  it('(b3) a falsy/null lead never crowds out a real bit (defensive precondition)', () => {
    // UNREACHABLE on the real cache (SQL filters nsfwLevel != 0/NULL), but a future
    // caller could pass a set with a null/0 lead. A falsy level is visible to NO
    // viewer, so it must NOT consume a coverage slot: all 6 distinct REAL bits still
    // get a representative. (6 real bits + a null lead = 7 items for 6 slots — the
    // one omitted is the unseeable lead; browsing-level safety > keeping it.)
    const imgs = [
      { id: 1, url: 'lead', nsfwLevel: null as number | null },
      ...makeLeveled([PG, PG13, R, X, XXX, BLOCKED]).map((x) => ({ ...x, id: x.id + 1 })),
    ];
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(new Set(out.map((i) => i.nsfwLevel))).toEqual(
      new Set([PG, PG13, R, X, XXX, BLOCKED])
    );
  });

  it('(b4) a falsy-level lead IS kept when the real bits leave a free slot', () => {
    // 3 distinct real bits + a 0-level lead + limit 6 → room to spare, so the curated
    // lead fills in (behavior matches the real path, where the lead carries a real bit).
    const imgs = [
      { id: 1, url: 'lead', nsfwLevel: 0 },
      ...makeLeveled([XXX, XXX, XXX, PG, R, XXX]).map((x) => ({ ...x, id: x.id + 1 })),
    ];
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out).toContain(imgs[0]); // curated lead kept via fill
    expect(new Set(out.map((i) => i.nsfwLevel))).toEqual(new Set([0, XXX, PG, R]));
  });

  it('(c) returns ≤ limit images in ORIGINAL cache order', () => {
    const imgs = makeLeveled([XXX, XXX, XXX, XXX, XXX, XXX, PG, PG13, R, X, XXX, XXX]);
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out.length).toBeLessThanOrEqual(GET_ALL_IMAGES_PER_MODEL_SLIM);
    const ids = out.map((i) => i.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // ascending index/id => cache order
  });

  it('(d) with fewer than the cap distinct levels, fills remaining slots by cache order', () => {
    // Only two distinct bits → coverage needs 2; the other 4 slots fill first-come.
    const imgs = makeLeveled([PG, PG, PG, PG, PG, PG, XXX, PG, PG]);
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL_SLIM);
    // covers both bits...
    expect(new Set(out.map((i) => i.nsfwLevel))).toEqual(new Set([PG, XXX]));
    // ...and the fill is the earliest PG images (ids 1..5) plus the XXX rep (id 7).
    expect(out.map((i) => i.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 7]);
  });

  it('(e) input at/under the cap is returned unchanged (same reference)', () => {
    const five = makeLeveled([PG, PG13, R, X, XXX]);
    expect(selectSlimGetAllModelImages(five, GET_ALL_IMAGES_PER_MODEL_SLIM)).toBe(five);
    const six = makeLeveled([PG, PG13, R, X, XXX, BLOCKED]);
    expect(selectSlimGetAllModelImages(six, GET_ALL_IMAGES_PER_MODEL_SLIM)).toBe(six);
  });

  it('does NOT mutate the source array (shared-cache safety)', () => {
    const imgs = makeLeveled([XXX, XXX, XXX, XXX, XXX, XXX, PG, PG13, R, X]);
    const before = [...imgs];
    const out = selectSlimGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(imgs).toEqual(before);
    expect(out).not.toBe(imgs);
  });

  describe('empty-rate property — the point of the bias', () => {
    // A model whose leading 6 images are all high-nsfw, with a lone PG image at index 8.
    const model = makeLeveled([XXX, XXX, XXX, XXX, XXX, XXX, XXX, XXX, PG, XXX]);
    const naiveFirst6 = model.slice(0, GET_ALL_IMAGES_PER_MODEL_SLIM);
    const biased = selectSlimGetAllModelImages(model, GET_ALL_IMAGES_PER_MODEL_SLIM);

    it('a PG-only viewer is DROPPED by naive first-6 but KEPT by the biased slice', () => {
      // PG-only viewer: browsingLevel = PG, maxSelectedLevel = PG.
      expect(anyVisibleBrowsing(naiveFirst6, PG)).toBe(false); // naive → feed_noimages_drop
      expect(anyVisibleBrowsing(biased, PG)).toBe(true); // biased → keeps a cover
      // full set was visible to them, so the cap must not newly drop them:
      expect(anyVisibleBrowsing(model, PG)).toBe(true);
      // and the biased slice actually pulled the index-8 PG image forward:
      expect(biased.some((i) => i.nsfwLevel === PG)).toBe(true);
      expect(naiveFirst6.some((i) => i.nsfwLevel === PG)).toBe(false);
    });

    it('(symmetric) highest-bit coverage keeps a high-only viewer whose only high image is late', () => {
      // Leading 6 all PG, the lone high image sits at index 8 — mirror case.
      const model2 = makeLeveled([PG, PG, PG, PG, PG, PG, PG, PG, XXX, PG]);
      const naive2 = model2.slice(0, GET_ALL_IMAGES_PER_MODEL_SLIM);
      const biased2 = selectSlimGetAllModelImages(model2, GET_ALL_IMAGES_PER_MODEL_SLIM);
      // high-only viewer: browsingLevel = XXX.
      expect(anyVisibleBrowsing(naive2, XXX)).toBe(false); // naive drops them
      expect(anyVisibleBrowsing(biased2, XXX)).toBe(true); // biased keeps the XXX rep
    });

    it('a permissive (see-everything) viewer still sees images[0] as the cover', () => {
      // Order preserved => the first surviving image for a permissive viewer is the lead.
      const seeAll = XXX | X | R | PG13 | PG | BLOCKED;
      const firstSurvivor = biased.find((i) => (i.nsfwLevel & seeAll) !== 0);
      expect(firstSurvivor).toBe(model[0]);
    });

    it('the max-level branch is covered by including the lowest bit present', () => {
      // A see-nothing-but-PG viewer (maxSelectedLevel = PG) keeps a cover iff the
      // slice carries the lowest bit (PG) — which the coverage step guarantees.
      expect(anyVisibleMaxLevel(model, PG)).toBe(true);
      expect(anyVisibleMaxLevel(naiveFirst6, PG)).toBe(false);
      expect(anyVisibleMaxLevel(biased, PG)).toBe(true);
    });
  });
});

describe('model-getall-images — buildGetAllModelImages biased flag', () => {
  const makeLeveledFull = (levels: number[]) =>
    levels.map((nsfwLevel, i) => ({ ...makeFullImage(i + 1), nsfwLevel }));

  it('OFF (default) path is the naive first-12, unchanged', () => {
    const imgs = makeLeveledFull(Array.from({ length: 20 }, () => XXX));
    // put a lone PG deep in the tail; the OFF path must NOT pull it forward.
    imgs[15] = { ...imgs[15], nsfwLevel: PG };
    const out = buildGetAllModelImages(imgs); // biased defaults to false
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL);
    expect(out.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('biased slim path pulls the coverage image forward and still field-trims', () => {
    const imgs = makeLeveledFull([XXX, XXX, XXX, XXX, XXX, XXX, XXX, XXX, PG, XXX]);
    const out = buildGetAllModelImages(imgs, GET_ALL_IMAGES_PER_MODEL_SLIM, true);
    expect(out).toHaveLength(GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(out.some((i) => i.nsfwLevel === PG)).toBe(true); // coverage
    for (const dropped of GETALL_DROPPED_IMAGE_FIELDS) {
      expect(out[0]).not.toHaveProperty(dropped); // field trim still applied
    }
    expect(out[0]).toHaveProperty('url');
    // shared cache untouched
    expect(imgs).toHaveLength(10);
    expect(imgs[0]).toHaveProperty('onSite');
  });
});
