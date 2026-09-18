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
      const descriptors = build({
        reaction: { getMyImageReactions: (input: unknown) => input },
      }) as { imageIds: number[] }[];
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
    queryResults.current = [];

    const { unmount } = renderHook(() => useHydratedImageReactions(images, { entity: 'image' }));

    expect(asked.current.map((input) => input.imageIds.length)).toEqual([100, 50]);
    expect(asked.current[1].imageIds[0]).toBe(101);
    unmount();
  });
});
