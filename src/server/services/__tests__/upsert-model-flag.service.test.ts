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
