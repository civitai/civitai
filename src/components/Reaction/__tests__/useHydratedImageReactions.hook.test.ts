// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hook BODY, not its two pure halves.
 *
 * `reactionQueryChunks` and `mergeUserImageReactions` are covered next door, but the wiring
 * between them — chunks into `trpc.useQueries`, results into `byImageId`, `byImageId` into the
 * merge — had no test of any kind, and review found three one-token edits inside it that switch
 * hydration off on the front page with the whole repo green. Two of them are dependency arrays,
 * one of which sits under an `eslint-disable-next-line react-hooks/exhaustive-deps`.
 *
 * 🔴 NOTHING ELSE CAN SEE THOSE. `react-hooks/exhaustive-deps` arrives via `next/core-web-vitals`
 * as a WARNING, and `lint` is `eslint src/` with no `--max-warnings` — the CI workflow says so out
 * loud, "Errors only (no --max-warnings): the repo has 3,470 warnings". So dependency-array
 * correctness has no automated enforcement anywhere in this repo. This test is the enforcement.
 *
 * It asserts a state that ARRIVES rather than one that leaves: the un-hydrated render is asserted
 * synchronously, then the queries are made to report data and the hydrated render is asserted.
 * Nothing here is on a timer, so there is no state that can delete itself out from under it.
 *
 * 🔴 WHICH DEP LIST A CASE CAN SEE IS DECIDED BY ITS FIXTURE, so check that before adding one.
 * The rule that generalises: `chunks` has three deps — the id join, `userId`, `entity` — and each
 * needs something to VARY across a rerender to be seen at all. The other two memos need something
 * to HOLD STILL, so a case whose `images` identity is fresh each render cannot see them.
 *
 * That makes the shapes mutually blind, and merging two of them to save a render closes one while
 * silently unarming the other. It also means "stable" and "growing" is not an exhaustive pair:
 * chunk COUNT is its own axis (only the 150-id case reaches multi-chunk handling, and it is not a
 * duplicate of the single-image one), and `userId` and `entity` are axes NO case varies today —
 * `useCurrentUser` is a constant mock and every case passes a fixed entity. Dropping either from
 * the `chunks` deps is green against every case in this file. Recorded rather than closed.
 */
const VIEWER = 9266475;

const queryResults = vi.hoisted(() => ({
  current: [] as { data?: Record<number, string[]>; dataUpdatedAt: number }[],
}));
const asked = vi.hoisted(() => ({ current: [] as { imageIds: number[] }[] }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: VIEWER }) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useQueries: (build: (t: unknown) => unknown[]) => {
      // ONE result per chunk, as the real `useQueries` gives. Returning the canned results
      // regardless of what the hook asked for would hand data to a surface that issued no query
      // at all — which is how the non-image case below passed against a broken stub the first
      // time it ran.
      // The descriptors are KEPT, not just counted. Counting alone leaves the stub blind to what
      // the hook actually asked for: `{ imageIds: chunk }` -> `{ imageIds: chunks[0] }` is green
      // against a counting stub, and in production it makes every chunk after the first ask about
      // the first one's ids, so the back half of a large grid never hydrates.
      // Both arguments, not just the input. `staleTime` is the entire point of sorting the ids —
      // a repeating key is worthless if nothing holds the answer — and it lives here, in the hook,
      // where the pure sort tests structurally cannot see it. Capturing half a descriptor leaves
      // the other half pinned by nothing.
      const descriptors = build({
        reaction: {
          getMyImageReactions: (input: unknown, opts: unknown) => ({ input, opts }),
        },
      }) as { input: { imageIds: number[] }; opts: { staleTime: number } }[];
      asked.current = descriptors;
      // Mapped, not sliced: a `queryResults` shorter than the descriptor list would silently hand
      // the hook fewer results than `useQueries` can ever return, which is a shape production
      // cannot produce. One result per descriptor, always.
      return descriptors.map(
        (_, i) => queryResults.current[i] ?? { data: undefined, dataUpdatedAt: 0 }
      );
    },
  },
}));

import type * as TrpcModule from '~/utils/trpc';
import { useHydratedImageReactions } from '~/components/Reaction/useHydratedImageReactions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const container = document.createElement('div');
  const root = createRoot(container);
  const Probe = () => {
    result.current = useHook();
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return {
    result,
    rerender: () => act(() => root.render(createElement(Probe))),
    unmount: () => act(() => root.unmount()),
  };
}

describe('useHydratedImageReactions wiring', () => {
  beforeEach(() => {
    // Reset explicitly. Inheriting the previous test's value would inherit it as HYDRATED data,
    // which is the direction that produces a false green.
    queryResults.current = [];
    asked.current = [];
  });

  it('merges a reaction that arrives after the first render', () => {
    // Hoisted out of the probe deliberately: a fresh `images` identity on every render would make
    // the final memo recompute regardless of its dep list, and the control for that dep list would
    // silently stop catching anything.
    const images = [{ id: 142799705, reactions: [] }];
    queryResults.current = [{ data: undefined, dataUpdatedAt: 0 }];

    const { result, rerender, unmount } = renderHook(() =>
      useHydratedImageReactions(images, { entity: 'image' })
    );

    // Negative control. Without this the test would pass over a hook that hydrates from nothing.
    expect(result.current[0].reactions).toEqual([]);

    queryResults.current = [{ data: { 142799705: ['Like'] }, dataUpdatedAt: 1 }];
    rerender();

    expect(result.current[0].reactions).toEqual([{ userId: VIEWER, reaction: 'Like' }]);
    unmount();
  });

  it('asks for nothing on a surface that is not images', () => {
    const images = [{ id: 1, reactions: [] }];
    queryResults.current = [{ data: { 1: ['Like'] }, dataUpdatedAt: 1 }];

    const { result, unmount } = renderHook(() =>
      useHydratedImageReactions(images, { entity: 'model' })
    );

    // What this proves is narrower than it looks, and the narrow thing is the point: the stub is
    // what withholds the answer, so this cannot tell a hook that filters from one that never
    // asked. It proves the gate survives the WHOLE BODY — chunking, `useQueries`, `byImageId`,
    // merge — which the pure `it.each` next door cannot, and it is the only test that would catch
    // `byImageId` being sourced from anything other than `queries`.
    // The assertion this case's NAME has been promising since it was written. `asked` did not
    // exist then; it arrived two rounds later and this case was never revisited. Without it the
    // case asserts only the output, which the pure `it.each` next door already covers — with it,
    // this is the only place pinning that no query is issued outside `chunks`.
    expect(asked.current).toEqual([]);
    expect(result.current[0].reactions).toEqual([]);
    unmount();
  });
});

describe('useHydratedImageReactions chunking, through the hook', () => {
  it('asks each chunk about its own ids', () => {
    // Unreachable on today's config — `FEED_FETCH_CEILING` and the collection limit are both 100,
    // which is `REACTION_FETCH_CHUNK`, so a block's pool is always one chunk. This covers the day
    // one of those numbers goes up, which is a one-token edit nothing else would connect to this.
    const images = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, reactions: [] }));
    queryResults.current = [
      { data: { 1: ['Like'] }, dataUpdatedAt: 1 },
      { data: { 150: ['Heart'] }, dataUpdatedAt: 1 },
    ];

    const { result, unmount } = renderHook(() =>
      useHydratedImageReactions(images, { entity: 'image' })
    );

    expect(asked.current.map((d) => d.input.imageIds.length)).toEqual([100, 50]);
    expect(asked.current[1].input.imageIds[0]).toBe(101);
    expect(asked.current[0].opts.staleTime).toBe(60_000);

    // The RESPONSE side, not just the request. Asserting only what was asked leaves
    // `Object.assign({}, ...queries.map(...))` -> `queries[0]?.data ?? {}` green, which drops
    // every chunk after the first: images 101+ render un-hydrated and the first click deletes.
    expect(result.current[0].reactions).toEqual([{ userId: VIEWER, reaction: 'Like' }]);
    expect(result.current[149].reactions).toEqual([{ userId: VIEWER, reaction: 'Heart' }]);
    unmount();
  });
});

describe('useHydratedImageReactions when the pool arrives after the first render', () => {
  it('asks once the pool arrives, not only for the pool it first saw', () => {
    // PRODUCTION'S ACTUAL SEQUENCE, and the only shape that reaches the `chunks` memo's dep list.
    // `useApplyHiddenPreferences` returns `items: []` unconditionally while hidden preferences
    // load, so every home block hands this hook an EMPTY array on its first render and the real
    // pool on a later one. Drop the id join from that dep list and `chunks` freezes at `[]`:
    // nothing is ever asked, the merge is a permanent no-op, and every card on the front page
    // renders un-hydrated and deletes on first click.
    //
    // Deliberately its own case rather than folded into the one above — `pool` has a fresh
    // identity each render, which is exactly what disarms the final memo's control.
    const pool = { current: [] as { id: number; reactions: never[] }[] };
    queryResults.current = [];

    const { result, rerender, unmount } = renderHook(() =>
      useHydratedImageReactions(pool.current, { entity: 'image' })
    );

    expect(asked.current).toEqual([]);

    pool.current = [{ id: 142799705, reactions: [] }];
    queryResults.current = [{ data: { 142799705: ['Like'] }, dataUpdatedAt: 1 }];
    rerender();

    expect(asked.current.map((d) => d.input.imageIds)).toEqual([[142799705]]);
    expect(result.current[0].reactions).toEqual([{ userId: VIEWER, reaction: 'Like' }]);

    // SAME LENGTH, different membership — the property the dep list actually encodes. Keying the
    // memo on `images.length` instead of the id join is green against a pool that only grows, and
    // `useApplyHiddenPreferences` hands back the PREVIOUS items during a refetch and then the new
    // ones, so for a full block — whose size comes from its config rather than its content — a
    // same-sized swap is the ordinary case, not an exotic one.
    pool.current = [{ id: 888, reactions: [] }];
    queryResults.current = [{ data: { 888: ['Cry'] }, dataUpdatedAt: 2 }];
    rerender();

    expect(asked.current.map((d) => d.input.imageIds)).toEqual([[888]]);
    expect(result.current[0].reactions).toEqual([{ userId: VIEWER, reaction: 'Cry' }]);
    unmount();
  });
});
