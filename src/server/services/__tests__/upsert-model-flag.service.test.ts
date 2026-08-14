import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Seam test for `upsertModelFlag`.
 *
 * `model-flag-upsert-sql.test.ts` proves the STATEMENT. It cannot prove that
 * the caller reaches the statement, or hands it the right arguments — and that
 * is the half where the production symptom lives. Mutating the guard below to
 * `if (isFlagged) return null` silently recreates the exact outage this code
 * was fixed for (nothing is ever recorded) while every statement-level test
 * stays green. So the guard is asserted in BOTH directions, by observing
 * whether a query is issued at all.
 *
 * `buildModelFlagUpsert` is deliberately NOT mocked: the point is to read the
 * arguments as they actually arrive at the database call.
 */

const { mockQueryRaw } = vi.hoisted(() => ({ mockQueryRaw: vi.fn() }));

// `model-flag.service` imports only `dbRead`/`dbWrite` from this module.
//
// This is a partial factory for a module that also does `export * from
// '@civitai/db/client'`, i.e. the shape that goes stale when the service
// starts importing something else from it. 🔴 The `await import(...)` inside
// each test below is load-bearing, not style: importing the service at module
// scope would let that staleness surface as a collection failure (0 tests,
// which reads as "nothing to see"). Importing inside the test body makes it
// fail loudly instead — verified by adding an unmocked export to the service's
// import graph and watching all four tests fail rather than vanish.
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: { $queryRaw: mockQueryRaw },
}));

const FLAGGED = {
  poi: false,
  nsfw: true,
  minor: false,
  triggerWords: false,
  poiName: false,
  sfwOnly: false,
};
const NOTHING_FLAGGED = { ...FLAGGED, nsfw: false };

describe('upsertModelFlag', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValue([{ modelId: 7 }]);
  });

  it('issues the upsert and returns the row when a flag is set', async () => {
    const { upsertModelFlag } = await import('~/server/services/model-flag.service');

    const result = await upsertModelFlag({ modelId: 7, scanResult: FLAGGED });

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ modelId: 7 });
  });

  it('issues NO query and returns null when nothing is flagged', async () => {
    const { upsertModelFlag } = await import('~/server/services/model-flag.service');

    const result = await upsertModelFlag({ modelId: 7, scanResult: NOTHING_FLAGGED });

    // The other half of the guard. Asserting only the flagged case above would
    // leave an inverted condition passing.
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('issues NO query when there is no scan result at all', async () => {
    const { upsertModelFlag } = await import('~/server/services/model-flag.service');

    const result = await upsertModelFlag({ modelId: 7 });

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('lets a database error propagate instead of swallowing it', async () => {
    const { upsertModelFlag } = await import('~/server/services/model-flag.service');
    mockQueryRaw.mockRejectedValue(new Error('relation "ModelFlag" does not exist'));

    // This whole incident was a statement that threw on every call while the
    // caller's `.catch(...)` hid it, so nothing recorded anything for 15.5
    // months and nobody saw an error. A `.catch(() => [null])` added here
    // would recreate that silence one layer lower — and it is the one mutant
    // that survives both the statement suite and the rest of this file.
    await expect(upsertModelFlag({ modelId: 7, scanResult: FLAGGED })).rejects.toThrow(
      'relation "ModelFlag" does not exist'
    );
  });

  it('forwards modelId, every flag and details through to the statement', async () => {
    const { upsertModelFlag } = await import('~/server/services/model-flag.service');

    await upsertModelFlag({
      modelId: 7,
      scanResult: { ...FLAGGED, minor: true },
      details: { verdict: 'x' },
    });

    // Reading the bound values proves the arguments survived the call, which a
    // "was it called" assertion cannot: dropping `details` or `scanResult` on
    // the way through still calls the query exactly once.
    const [statement] = mockQueryRaw.mock.calls[0];
    expect(statement.values).toEqual([
      7,
      false,
      true,
      true,
      false,
      false,
      'Pending',
      JSON.stringify({ verdict: 'x' }),
      false,
    ]);
  });
});
