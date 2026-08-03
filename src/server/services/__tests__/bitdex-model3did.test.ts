import { describe, expect, it, vi } from 'vitest';

// 🔴 NOT ABOUT THIS FILE'S ASSERTIONS — it is about its EXIT CODE. The code
// under test is pure, but it is reached through a module that imports
// `~/server/db/client` at module scope, which instantiates Prisma and leaves an
// UNHANDLED rejection. That rejection fails no test; it only makes the runner
// exit non-zero, so `rc` here did not describe the tests and any mutation sweep
// reading it reported every mutant killed. Nothing below touches a database.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

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
