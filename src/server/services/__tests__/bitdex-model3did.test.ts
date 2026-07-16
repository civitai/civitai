import { describe, expect, it } from 'vitest';
import { mapBitdexDoc } from '~/server/services/image.service';

// model3dId is indexed per-image on BitDex from `Post.model3dId` (the index
// analog of `postedToId`). getAllImagesIndex relies on a THREE-STATE signal to
// gate the model3d chip without leaking a hidden link:
//   - a number   → a real, visibility-gated model3d link
//   - null       → "confirmed no link" (Meili only; suppresses the fallback)
//   - undefined  → "not indexed by this backend" → self-healing postId fallback
// BitDex is the `undefined` producer. mapBitdexDoc therefore emits model3dId
// ONLY when the doc actually carries a value, and does not coerce a missing
// value to null. This keeps the doc-level signal honest (belt-and-suspenders):
// the getAllImagesIndex fallback ultimately keys off page-level `searchSource`,
// so a stray null would NOT by itself break the fallback — but null reads as
// "confirmed no link" and muddies the signal, so we keep it absent.

// Minimal BitDex doc with the fields mapBitdexDoc reads (sortAt is required —
// it is multiplied for sortAtUnix). Everything else defaults through `?? ...`.
const makeDoc = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 123,
  url: 'abc.jpeg',
  nsfwLevel: 1,
  userId: 500,
  sortAt: 1_700_000_000,
  hasMeta: true,
  onSite: false,
  poi: false,
  minor: false,
  ...overrides,
});

describe('mapBitdexDoc model3dId three-state contract', () => {
  it('surfaces model3dId as a number when the doc carries one (post-redump)', () => {
    const mapped = mapBitdexDoc(makeDoc({ model3dId: 987 }));
    expect(mapped).toHaveProperty('model3dId', 987);
  });

  it('leaves model3dId undefined (key absent) when the doc has no value — NOT null', () => {
    const mapped = mapBitdexDoc(makeDoc());
    // The key stays absent so downstream sees `undefined` (a number is the only
    // positive signal). Not fallback-critical — searchSource drives that — but a
    // stray `null` would read as "confirmed no link" and muddy the doc signal.
    expect('model3dId' in mapped).toBe(false);
    expect((mapped as { model3dId?: number }).model3dId).toBeUndefined();
  });

  it('treats an explicit null the same as absent (must not pass null through)', () => {
    const mapped = mapBitdexDoc(makeDoc({ model3dId: null }));
    expect('model3dId' in mapped).toBe(false);
    expect((mapped as { model3dId?: number }).model3dId).toBeUndefined();
  });
});
