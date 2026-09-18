// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import {
  MODEL_SALE_IDS_PER_QUERY,
  MODEL_SALE_IDS_PER_REQUEST,
  getActiveSalesSchema,
} from '~/server/schema/model-sale.schema';

/**
 * 🔴 THE REGRESSION: `model.getActiveSales` caps `ids`, and this hook fed it the WHOLE accumulated
 * list of an infinite feed. Past the cap every call was rejected before the resolver ran, so the
 * sale badge disappeared from the entire grid for anyone who scrolled far enough — a 400, so
 * nothing watching server errors ever saw it.
 *
 * No request the hook builds may be rejectable, and that is asserted by running each one through
 * THE ACTUAL SCHEMA the procedure validates with. Because the chunk size and the cap are SEPARATE
 * constants, that is a real relationship rather than a restatement of one symbol.
 *
 * 🔴 THE RECORDER TAKES BOTH ENTRY POINTS ON PURPOSE. The pre-change hook called
 * `trpc.model.getActiveSales.useQuery`; the fixed one fans out through `trpc.useQueries`. A fake
 * offering only the second makes the old code die on an undefined property — red, but for the wrong
 * reason. Recording either is what makes the red read "one request of N ids", which is the defect.
 * The cost is that a `.map` of `useQuery` calls would satisfy every request-shape assertion here
 * while making React's hook count vary with the feed length (a hard "Rendered more hooks than
 * during the previous render" at exactly this boundary, which eslint's `rules-of-hooks` does NOT
 * catch on a deep member chain), so the entry point used is counted and asserted separately.
 */
const recorded = vi.hoisted(() => {
  const requests: number[][] = [];
  const options: Record<string, unknown>[] = [];
  const calls = { useQuery: 0, useQueries: 0 };
  /**
   * Per-id override, so a test can make one model's sale already over — and it takes a STRING as
   * well as a Date, because the wire carries either depending on the response serializer and the
   * hook re-wraps for exactly that reason. A Date-only fake leaves the re-wrap unobserved.
   */
  const endsAtById = new Map<number, Date | string>();
  /** Ids whose chunk is deliberately still in flight. */
  const pending = new Set<number>();
  const RUNNING = new Date('2999-01-01T00:00:00.000Z');
  /**
   * `dataUpdatedAt` is STABLE per id-set, as React Query's is: it stamps on resolve, not on read.
   * A counter bumped per call moves the merge memo's key on every RENDER, which makes the memo
   * never memoize and hides both a missing memo and an over-eager key.
   */
  const stamps = new Map<string, number>();
  let clock = 0;
  const stampFor = (key: string) => {
    const seen = stamps.get(key);
    if (seen) return seen;
    stamps.set(key, ++clock);
    return clock;
  };

  const salesFor = (ids: number[]) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        { endsAt: endsAtById.get(id) ?? RUNNING, discountType: 'Percent', discountAmount: 25 },
      ])
    );

  const record = (input: { ids: number[] }, opts?: Record<string, unknown>) => {
    // Honouring `enabled` matters for the matrix, not just for realism: without it the pre-chunking
    // hook — which gated its single query on `ids.length > 0` — reds on the empty-surface case too,
    // and a red that is an artefact of the fake makes the real ones harder to believe.
    if (opts?.enabled === false) return { data: undefined, dataUpdatedAt: 0 };
    requests.push(input.ids);
    options.push(opts ?? {});
    if (input.ids.some((id) => pending.has(id))) return { data: undefined, dataUpdatedAt: 0 };
    return { data: salesFor(input.ids), dataUpdatedAt: stampFor(input.ids.join(',')) };
  };

  return {
    requests,
    options,
    calls,
    endsAtById,
    pending,
    reset() {
      requests.length = 0;
      options.length = 0;
      calls.useQuery = 0;
      calls.useQueries = 0;
      endsAtById.clear();
      pending.clear();
      stamps.clear();
      clock = 0;
    },
    useQuery: (input: { ids: number[] }, opts?: Record<string, unknown>) => {
      calls.useQuery++;
      return record(input, opts);
    },
    useQueries: (build: (t: Record<string, unknown>) => unknown[]) => {
      calls.useQueries++;
      return build({ model: { getActiveSales: record } });
    },
  };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    model: { getActiveSales: { useQuery: recorded.useQuery } },
    useQueries: recorded.useQueries,
  },
}));

import { useModelSaleBadge, useModelSaleBadges } from '~/components/Cards/ModelCardContext';
import { isLargeQuery } from '~/utils/trpc';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** Renders, and can RE-render with new args — which is what the memo keys need to be observable. */
function renderHook<A extends unknown[], T>(useHook: (...args: A) => T, ...initial: A) {
  const result = { current: undefined as T };
  const root = createRoot(document.createElement('div'));
  let args = initial;
  function Probe() {
    result.current = useHook(...args);
    return null;
  }
  const render = () =>
    act(() => {
      root.render(createElement(Probe));
    });
  render();
  return {
    result,
    rerender: (...next: A) => {
      args = next;
      render();
      return result.current;
    },
  };
}

/**
 * A feed's ids, in feed order. 🔴 DELIBERATELY DESCENDING, so a sorted derivation cannot coincide
 * with the expected result — arrival order is what keeps an already-fetched chunk's key stable, and
 * `.sort((a, b) => a - b)` is literally the line this fix deleted.
 */
const feedIds = (count: number) => Array.from({ length: count }, (_, i) => 900000 - i * 7);

/**
 * A scrolled feed: several full chunks and a partial one.
 *
 * 🔴 A LITERAL, AND IT MUST EXCEED THE CAP — not the chunk. Sized off the chunk it would sit UNDER
 * the cap, and then the un-chunked shape this file exists to catch (one request carrying every id)
 * would parse cleanly and the headline assertion would pass having caught nothing. Measured: at a
 * fixture of 220 the reverted hook was green on it. The assertion below is the positive control
 * that keeps it honest if either constant moves.
 */
const SCROLLED = 1200;

beforeEach(() => {
  recorded.reset();
});

describe('useModelSaleBadges', () => {
  it('never builds a request the procedure would reject', () => {
    const ids = feedIds(SCROLLED);

    // Positive control on the FIXTURE: one request of every id has to be over the cap, or a hook
    // that does not chunk at all satisfies this test.
    expect(ids.length).toBeGreaterThan(MODEL_SALE_IDS_PER_QUERY);

    renderHook(useModelSaleBadges, ids);

    // Asserted before the filter: a `.filter(...)` over an empty array is `[]`, which would pass
    // this having measured nothing.
    expect(recorded.requests.length).toBeGreaterThan(0);
    const rejected = recorded.requests
      .filter((request) => !getActiveSalesSchema.safeParse({ ids: request }).success)
      .map((request) => request.length);
    expect(rejected).toEqual([]);
  });

  it('keeps a chunk small enough to stay a GET', () => {
    // The second half of the sizing argument, asserted rather than only reasoned about in the
    // schema comment: `isLargeQuery` is what rewrites a query into a body-carrying POST on the link
    // ALL live traffic uses. 7-digit ids, because that is what a real model id costs.
    const chunk = Array.from({ length: MODEL_SALE_IDS_PER_REQUEST }, (_, i) => 9000000 - i);

    expect(isLargeQuery({ type: 'query', input: { ids: chunk } })).toBe(false);
    // Positive control: the sizer does say yes to something, so the `false` above is a measurement
    // and not a function that never fires. A chunk at the CAP is exactly what used to be a POST.
    const atCap = Array.from({ length: MODEL_SALE_IDS_PER_QUERY }, (_, i) => 9000000 - i);
    expect(isLargeQuery({ type: 'query', input: { ids: atCap } })).toBe(true);
  });

  it('hands out the same object when nothing has changed', () => {
    const ids = feedIds(MODEL_SALE_IDS_PER_REQUEST);

    const { result, rerender } = renderHook(useModelSaleBadges, ids);
    const first = result.current;

    // Referential stability is the consumer-visible property: `ModelCardContextProvider` memoises on
    // this value, so a fresh object per render re-renders every memoised card in the grid.
    expect(rerender([...ids])).toBe(first);
  });

  it('fans out through useQueries, never a useQuery per chunk', () => {
    renderHook(useModelSaleBadges, feedIds(SCROLLED));

    expect(recorded.calls).toEqual({ useQueries: 1, useQuery: 0 });
  });

  it('asks about every card exactly once, over as few requests as the chunk allows', () => {
    const ids = feedIds(SCROLLED);

    renderHook(useModelSaleBadges, ids);

    // Counted, not diffed: `toEqual` on the whole list buries the number that matters. One request
    // short is a truncated surface; a per-card fan-out would read `ids.length` here.
    expect(recorded.requests.length).toBe(Math.ceil(ids.length / MODEL_SALE_IDS_PER_REQUEST));

    const asked = recorded.requests.flat();
    // Coverage AND no duplication: a chunker that overlapped its windows would still badge every
    // card, at a cost this endpoint is capped precisely to avoid.
    expect(asked.length).toBe(ids.length);
    const askedSet = new Set(asked);
    expect(ids.filter((id) => !askedSet.has(id))).toEqual([]);

    // 🔴 ARRIVAL ORDER, read off the request rather than trusted. A sort would still cover every id
    // and still pass every assertion above, while moving the boundary of a chunk the feed has
    // already fetched — the growth property the next test measures.
    expect(recorded.requests[0]).toEqual(ids.slice(0, MODEL_SALE_IDS_PER_REQUEST));
  });

  it('leaves an already-fetched request untouched when the feed grows', () => {
    const first = feedIds(MODEL_SALE_IDS_PER_REQUEST);
    const grown = feedIds(MODEL_SALE_IDS_PER_REQUEST + 20);

    const { rerender } = renderHook(useModelSaleBadges, first);
    const before = [...recorded.requests[0]];
    rerender(grown);

    // Growing by a page adds a request; it does not re-key the ones already answered. Otherwise
    // every page re-asks the whole surface, which is the cost chunking exists to remove.
    expect(recorded.requests[0]).toEqual(before);
    expect(recorded.requests.at(-1)).toEqual(grown.slice(MODEL_SALE_IDS_PER_REQUEST));
  });

  it('bounds how often a chunk may refetch', () => {
    renderHook(useModelSaleBadges, feedIds(MODEL_SALE_IDS_PER_REQUEST));

    // The only thing rate-limiting a public procedure whose work is per id.
    expect(recorded.options[0]).toMatchObject({ staleTime: 60_000 });
  });

  it('returns a badge for every model across the chunk boundaries', () => {
    const ids = feedIds(SCROLLED);

    const sales = renderHook(useModelSaleBadges, ids).result.current;

    // Checked at the ends and across both seams rather than by count alone: a merge that kept only
    // the last chunk still has "some" entries.
    expect(Object.keys(sales ?? {})).toHaveLength(ids.length);
    for (const id of [
      ids[0],
      ids[MODEL_SALE_IDS_PER_REQUEST - 1],
      ids[MODEL_SALE_IDS_PER_REQUEST],
      ids[MODEL_SALE_IDS_PER_REQUEST * 2],
      ids[ids.length - 1],
    ])
      expect(sales?.[id]).toMatchObject({ discountType: 'Percent', discountAmount: 25 });
  });

  it('takes up a chunk that lands after the first render', () => {
    const ids = feedIds(MODEL_SALE_IDS_PER_REQUEST * 2);
    ids.slice(MODEL_SALE_IDS_PER_REQUEST).forEach((id) => recorded.pending.add(id));

    const { result, rerender } = renderHook(useModelSaleBadges, ids);
    // Partly loaded: the answered chunk badges now, rather than the grid waiting on the slowest.
    expect(Object.keys(result.current ?? {})).toHaveLength(MODEL_SALE_IDS_PER_REQUEST);

    recorded.pending.clear();
    const after = rerender([...ids]);

    // The merge's memo key has to move with the new chunk's data, or a scrolled feed keeps showing
    // the first page's badges and nothing else — the original symptom wearing a different hat.
    expect(Object.keys(after ?? {})).toHaveLength(ids.length);
  });

  it('holds the previous map while a changed chunk is in flight', () => {
    const ids = feedIds(MODEL_SALE_IDS_PER_REQUEST);

    const { rerender } = renderHook(useModelSaleBadges, ids);

    // Every chunk re-keys and none has answered — what a filter change does. `placeholderData`
    // cannot cover this under `useQueries` (QueriesObserver matches previous observers by
    // queryHash, so a changed key gets a fresh observer with no previous data), so without the
    // hook's own keep-previous the whole grid's badges blank for the round trip.
    const next = ids.map((id) => id + 1);
    next.forEach((id) => recorded.pending.add(id));
    const during = rerender(next);

    expect(Object.keys(during ?? {})).toHaveLength(MODEL_SALE_IDS_PER_REQUEST);
    expect(during?.[ids[0]]).toMatchObject({ discountAmount: 25 });
  });

  it('does not let the held map resurrect a sale that has since ended', () => {
    // 🔴 The hole the keep-previous arm opened: the map was checked against the clock when it was
    // BUILT, so holding it re-served a window that closed in the meantime. The gate has to sit on
    // the map being handed out, not on the merge — a stamp is not a gate.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const ids = feedIds(MODEL_SALE_IDS_PER_REQUEST);
      recorded.endsAtById.set(ids[0], new Date('2026-01-01T00:30:00.000Z'));

      const { rerender } = renderHook(useModelSaleBadges, ids);

      const next = ids.map((id) => id + 1);
      next.forEach((id) => recorded.pending.add(id));
      // The fallback is now in play AND that one sale has ended since the map was stored.
      vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const during = rerender(next);

      expect(during?.[ids[0]]).toBeUndefined();
      // The rest of the held map still badges — this drops the closed window, not the fallback.
      expect(Object.keys(during ?? {})).toHaveLength(MODEL_SALE_IDS_PER_REQUEST - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a sale whose window has already closed', () => {
    const ids = feedIds(3);
    recorded.endsAtById.set(ids[1], new Date('2000-01-01T00:00:00.000Z'));

    const sales = renderHook(useModelSaleBadges, ids).result.current;

    // `endsAt` rode the wire from the start and nothing branched on it. A full chunk's key is
    // stable, so without this the card advertises a discount the charge path refuses.
    expect(
      Object.keys(sales ?? {})
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual([ids[0], ids[2]].sort((a, b) => a - b));
  });

  it('asks nothing at all for an empty surface', () => {
    const sales = renderHook(useModelSaleBadges, [] as number[]).result.current;

    expect(recorded.requests).toEqual([]);
    // `undefined`, not `{}` — a consumer reads "not loaded", the same as before chunking.
    expect(sales).toBeUndefined();
  });

  it('reads an endsAt that arrived as a string, not a Date', () => {
    // 🔴 The response serializer decides which one lands, which is why the hook re-wraps and why
    // `ModelVersionSaleBadge` types it `Date | string`. Asserted, because the obvious simplification
    // — `sale.endsAt.getTime()` on the strength of the local type — throws inside a render on the
    // string path, taking the card surface down.
    const ids = feedIds(2);
    recorded.endsAtById.set(ids[0], '2000-01-01T00:00:00.000Z');
    recorded.endsAtById.set(ids[1], '2999-01-01T00:00:00.000Z');

    const sales = renderHook(useModelSaleBadges, ids).result.current;

    expect(sales?.[ids[0]]).toBeUndefined();
    expect(sales?.[ids[1]]).toMatchObject({ discountAmount: 25 });
  });

  it('asks about a duplicated model once', () => {
    // Non-monotonic, so the expected result cannot coincide with a sorted derivation.
    const sales = renderHook(useModelSaleBadges, [8, 7, 8, 7]).result.current;

    expect(recorded.requests).toEqual([[8, 7]]);
    expect(Object.keys(sales ?? {})).toHaveLength(2);
  });
});

/**
 * The card rendered OUTSIDE a provider — home blocks, collections, related models. It caches its
 * answer for `staleTime` just as the batched hook does, so it needs the same end-edge re-check; the
 * one suite that renders a card mocks this hook away, so nothing else in the repo can see it.
 */
describe('useModelSaleBadge', () => {
  it('returns a running sale', () => {
    const sale = renderHook(useModelSaleBadge, 7, false).result.current;

    expect(sale).toMatchObject({ discountType: 'Percent', discountAmount: 25 });
  });

  it('drops a sale whose window has already closed', () => {
    recorded.endsAtById.set(7, new Date('2000-01-01T00:00:00.000Z'));

    expect(renderHook(useModelSaleBadge, 7, false).result.current).toBeUndefined();
  });

  it('asks nothing when a provider owns the lookup', () => {
    // The skip flag is "a provider owns this", so a card inside a grid must not fire its own query.
    expect(renderHook(useModelSaleBadge, 7, true).result.current).toBeUndefined();
    expect(recorded.requests).toEqual([]);
  });
});
