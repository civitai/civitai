import { describe, expect, it } from 'vitest';
import { mapBitdexDoc } from '~/server/services/image.service';

// model3dId is indexed per-image on BitDex from `Post.model3dId` (the index
// analog of `postedToId`). getAllImagesIndex relies on a THREE-STATE signal to
// gate the model3d chip without leaking a hidden link:
//   - a number   → a real, visibility-gated model3d link
//   - null       → "confirmed no link" (Meili only; suppresses the fallback)
//   - undefined  → "not indexed by this backend" → self-healing postId fallback
// BitDex is the `undefined` producer. mapBitdexDoc must therefore emit model3dId
// ONLY when the doc actually carries a value, and must NEVER coerce a missing
// value to null — a `?? null` regression here would silently assert "no link"
// for genuinely-linked images in the window before the redump populates the
// field, suppressing the fallback that would otherwise heal them.

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
    // The key must be absent so downstream sees `undefined` and takes the
    // self-healing postId fallback. `null` would wrongly read as "confirmed no
    // link" for the whole BitDex page.
    expect('model3dId' in mapped).toBe(false);
    expect((mapped as { model3dId?: number }).model3dId).toBeUndefined();
  });

  it('treats an explicit null the same as absent (must not pass null through)', () => {
    const mapped = mapBitdexDoc(makeDoc({ model3dId: null }));
    expect('model3dId' in mapped).toBe(false);
    expect((mapped as { model3dId?: number }).model3dId).toBeUndefined();
  });
});
