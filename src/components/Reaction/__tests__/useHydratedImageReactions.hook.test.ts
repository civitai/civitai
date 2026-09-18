// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: VIEWER }) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useQueries: (build: (t: unknown) => unknown[]) => {
      // ONE result per chunk, as the real `useQueries` gives. Returning the canned results
      // regardless of what the hook asked for would hand data to a surface that issued no query
      // at all — which is how the non-image case below passed against a broken stub the first
      // time it ran.
      const descriptors = build({ reaction: { getMyImageReactions: () => undefined } });
      return queryResults.current.slice(0, descriptors.length);
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
  it('merges a reaction that arrives after the first render', () => {
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

    // The data is present and must still not be applied: the gate is in the chunking, so a
    // non-image surface never asked for it and must not consume someone else's answer either.
    expect(result.current[0].reactions).toEqual([]);
    unmount();
  });
});
