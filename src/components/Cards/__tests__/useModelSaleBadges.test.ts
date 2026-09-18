// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { MODEL_SALE_IDS_PER_QUERY, getActiveSalesSchema } from '~/shared/zod/model-sale.schema';

/**
 * 🔴 THE REGRESSION: `model.getActiveSales` caps `ids` at `MODEL_SALE_IDS_PER_QUERY`, and this hook
 * fed it the WHOLE accumulated list of an infinite feed. Past the cap every call was rejected before
 * the resolver ran, so the sale badge disappeared from the entire grid for anyone who scrolled far
 * enough — a 400, so nothing watching server errors ever saw it.
 *
 * The property asserted is that no request the hook builds can be rejected, and it is asserted by
 * running each one through THE ACTUAL SCHEMA the procedure validates with — not against a number
 * restated here. A raised chunk size, a lowered cap, or the two drifting apart all red.
 *
 * 🔴 THE RECORDER TAKES BOTH SHAPES ON PURPOSE. The pre-change hook called
 * `trpc.model.getActiveSales.useQuery`; the fixed one fans out through `trpc.useQueries`. A fake
 * offering only the second makes the old code die on an undefined property — red, but for the wrong
 * reason, and it would go on being red for a hook that fanned out one request PER CARD. Recording
 * either shape is what makes the red here read "1200 ids in one request", which is the defect.
 */
const recorded = vi.hoisted(() => {
  const requests: number[][] = [];

  /** Every id asked for comes back on sale, so a dropped id is visible as a missing badge. */
  const salesFor = (ids: number[]) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          endsAt: new Date('2026-03-08T00:00:00.000Z'),
          discountType: 'Percent',
          discountAmount: 25,
        },
      ])
    );

  const record = (input: { ids: number[] }, options?: { enabled?: boolean }) => {
    // Honouring `enabled` matters for the matrix, not just for realism: without it the pre-chunking
    // hook — which gated its single query on `ids.length > 0` — reds on the empty-surface case too,
    // and a red that is an artefact of the fake makes the real ones harder to believe.
    if (options?.enabled === false) return { data: undefined, dataUpdatedAt: 0 };
    requests.push(input.ids);
    return { data: salesFor(input.ids), dataUpdatedAt: 1 };
  };

  return { requests, record };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    model: { getActiveSales: { useQuery: recorded.record } },
    useQueries: (build: (t: Record<string, unknown>) => unknown[]) =>
      build({ model: { getActiveSales: recorded.record } }),
  },
}));

import { useModelSaleBadges } from '~/components/Cards/ModelCardContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const root = createRoot(document.createElement('div'));
  function Probe() {
    result.current = useHook();
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return result;
}

/** A feed scrolled past the cap: ids in feed order, which is not sorted order. */
const feedIds = (count: number) => Array.from({ length: count }, (_, i) => 900000 - i * 7);

beforeEach(() => {
  // Emptied in place, never reassigned: the recorder closes over THIS array, so `= []` would
  // hand the assertions a second array nothing ever writes to — every count would read 0.
  recorded.requests.length = 0;
});

describe('useModelSaleBadges', () => {
  it('never builds a request the procedure would reject', () => {
    const ids = feedIds(MODEL_SALE_IDS_PER_QUERY * 2 + 200);

    renderHook(() => useModelSaleBadges(ids));

    // Asserted before the loop: a `for … expect` over an empty array makes no assertions at all
    // and still reports green.
    expect(recorded.requests.length).toBeGreaterThan(0);
    const rejected = recorded.requests
      .filter((request) => !getActiveSalesSchema.safeParse({ ids: request }).success)
      .map((request) => request.length);
    expect(rejected).toEqual([]);
  });

  it('asks about every card exactly once, over as few requests as the cap allows', () => {
    const ids = feedIds(MODEL_SALE_IDS_PER_QUERY * 2 + 200);

    renderHook(() => useModelSaleBadges(ids));

    // Counted, not diffed: `toEqual` on 1200 ids prints 1200 lines and buries the number that
    // matters. As few requests as the cap allows — one call short is a truncated surface, and a
    // per-card fan-out would read 1200 here.
    expect(recorded.requests.length).toBe(Math.ceil(ids.length / MODEL_SALE_IDS_PER_QUERY));

    const asked = recorded.requests.flat();
    // Coverage AND no duplication: a chunker that overlapped its windows would still badge every
    // card, at a cost this endpoint is capped precisely to avoid.
    expect(asked.length).toBe(ids.length);
    const askedSet = new Set(asked);
    expect(ids.filter((id) => !askedSet.has(id))).toEqual([]);
  });

  it('returns a badge for every model across the chunk boundary', () => {
    const ids = feedIds(MODEL_SALE_IDS_PER_QUERY * 2 + 200);

    const sales = renderHook(() => useModelSaleBadges(ids)).current;

    // The merge, checked at the ends and across both seams rather than by count alone: a merge that
    // kept only the last chunk still has "some" entries.
    expect(Object.keys(sales ?? {})).toHaveLength(ids.length);
    for (const id of [
      ids[0],
      ids[MODEL_SALE_IDS_PER_QUERY - 1],
      ids[MODEL_SALE_IDS_PER_QUERY],
      ids[MODEL_SALE_IDS_PER_QUERY * 2],
      ids[ids.length - 1],
    ])
      expect(sales?.[id]).toMatchObject({ discountType: 'Percent', discountAmount: 25 });
  });

  it('asks nothing at all for an empty surface', () => {
    const sales = renderHook(() => useModelSaleBadges([])).current;

    expect(recorded.requests).toEqual([]);
    // `undefined`, not `{}` — a consumer reads "not loaded", the same as before chunking.
    expect(sales).toBeUndefined();
  });

  it('asks about a duplicated model once', () => {
    const sales = renderHook(() => useModelSaleBadges([7, 7, 8, 7])).current;

    expect(recorded.requests).toEqual([[7, 8]]);
    expect(Object.keys(sales ?? {})).toHaveLength(2);
  });
});
