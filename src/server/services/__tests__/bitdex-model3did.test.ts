import { describe, expect, it } from 'vitest';
import { mapBitdexDoc } from '~/server/services/image.service';

// mapBitdexDoc must emit model3dId only when the doc carries a number, and must
// never coerce a missing value to null: downstream treats a number as a real
// link, null as "confirmed no link", and undefined as "not indexed here".

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
    expect('model3dId' in mapped).toBe(false);
    expect((mapped as { model3dId?: number }).model3dId).toBeUndefined();
  });

  it('treats an explicit null the same as absent (must not pass null through)', () => {
    const mapped = mapBitdexDoc(makeDoc({ model3dId: null }));
    expect('model3dId' in mapped).toBe(false);
    expect((mapped as { model3dId?: number }).model3dId).toBeUndefined();
  });
});
