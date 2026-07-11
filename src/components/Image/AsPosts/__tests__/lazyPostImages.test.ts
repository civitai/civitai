import { describe, expect, it } from 'vitest';
import {
  mergePostImages,
  POST_TAIL_PREFETCH_THRESHOLD,
  shouldFetchPostTail,
} from '~/components/Image/AsPosts/lazyPostImages';

// Pure decision logic for the gallery's lazy per-post carousel. These run in node
// (no DOM), so the browser component test only has to cover wiring.

describe('shouldFetchPostTail', () => {
  // Typical lazy post: seeded with 6 (the slice), true total 20.
  const loadedCount = 6;
  const total = 20;

  it('does NOT fetch while the active slide is comfortably inside the loaded set', () => {
    // threshold = 2 → fetch once currentIndex >= 6 - 2 = 4
    expect(shouldFetchPostTail({ currentIndex: 0, loadedCount, total })).toBe(false);
    expect(shouldFetchPostTail({ currentIndex: 3, loadedCount, total })).toBe(false);
  });

  it('fetches on APPROACH (within threshold of the loaded edge) — hides the round-trip', () => {
    expect(POST_TAIL_PREFETCH_THRESHOLD).toBe(2);
    expect(shouldFetchPostTail({ currentIndex: 4, loadedCount, total })).toBe(true); // 6-2
    expect(shouldFetchPostTail({ currentIndex: 5, loadedCount, total })).toBe(true);
  });

  it('fetches when the user jumps straight to the (unloaded) end via an indicator', () => {
    expect(shouldFetchPostTail({ currentIndex: 19, loadedCount, total })).toBe(true);
  });

  it('never fetches once everything is loaded (loadedCount >= total)', () => {
    expect(shouldFetchPostTail({ currentIndex: 19, loadedCount: 20, total: 20 })).toBe(false);
    expect(shouldFetchPostTail({ currentIndex: 25, loadedCount: 20, total: 18 })).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(shouldFetchPostTail({ currentIndex: 1, loadedCount: 6, total: 20, threshold: 5 })).toBe(
      true
    ); // 6-5=1
    expect(shouldFetchPostTail({ currentIndex: 0, loadedCount: 6, total: 20, threshold: 5 })).toBe(
      false
    );
  });
});

describe('mergePostImages', () => {
  const seed = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it('appends the tail after the seed, preserving order', () => {
    const out = mergePostImages(seed, [{ id: 4 }, { id: 5 }]);
    expect(out.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('de-duplicates by id (the tail overlaps the seed — getInfinite returns the whole post)', () => {
    // getInfinite({postId}) returns ALL images incl. the leading slice; the seed
    // stays authoritative for its ids, the tail only contributes the new ones.
    const out = mergePostImages(seed, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    expect(out.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
    // the seed objects are kept (not replaced by the tail copies)
    expect(out[0]).toBe(seed[0]);
  });

  it('keeps the cover (index 0) from the seed', () => {
    const out = mergePostImages(seed, [{ id: 9 }]);
    expect(out[0]).toBe(seed[0]);
  });

  it('returns the seed untouched when the tail is empty', () => {
    expect(mergePostImages(seed, [])).toBe(seed);
  });

  it('does not mutate the inputs', () => {
    const s = [{ id: 1 }];
    const t = [{ id: 2 }];
    mergePostImages(s, t);
    expect(s).toEqual([{ id: 1 }]);
    expect(t).toEqual([{ id: 2 }]);
  });
});
