// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

// React 18.3 exposes `act` on the `react` export, but our @types/react (18.0.14)
// predates that typing. Use the runtime `React.act` (no test-utils deprecation
// warning) and borrow the correctly-typed signature from react-dom/test-utils.
const act = (React as unknown as { act: typeof actType }).act;

// --- module mocks (must be declared before importing the hook) ---
const queryMock = vi.fn<(input: { modelIds: number[] }) => Promise<Record<string, number[]>>>();
vi.mock('~/utils/trpc', () => ({
  trpcVanilla: { user: { getEngagedModelsByIds: { query: (input: { modelIds: number[] }) => queryMock(input) } } },
}));

let currentUser: unknown = { id: 1 };
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => currentUser,
}));

import {
  __resetEngagedMembershipBatcher,
  engagedMembershipBatcher,
  requestEngagedMembership,
  useEngagedModelsMembership,
  useEngagedModelMembership,
} from '~/hooks/useEngagedModelMembership';
import { useEngagedModelsStore } from '~/store/engaged-models.store';

// deterministic scheduler: capture the flush callback, fire it on demand.
let scheduledFlush: (() => void) | null = null;
function runFlush() {
  const cb = scheduledFlush;
  scheduledFlush = null;
  cb?.();
}
/** let queued microtasks (the fetch .then) settle. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useEngagedModelsStore.getState().reset();
  __resetEngagedMembershipBatcher();
  queryMock.mockReset();
  queryMock.mockResolvedValue({});
  currentUser = { id: 1 };
  engagedMembershipBatcher.schedule = (cb) => { scheduledFlush = cb; };
  engagedMembershipBatcher.fetch = (modelIds) => queryMock({ modelIds });
});

afterEach(() => {
  scheduledFlush = null;
});

// ---------------------------------------------------------------------------
// Batcher core (no React) — the DataLoader mechanics
// ---------------------------------------------------------------------------
describe('batcher', () => {
  it('coalesces N requests in one tick into ONE query with the deduped union', async () => {
    queryMock.mockResolvedValue({ Recommended: [2] });
    requestEngagedMembership([1, 2]);
    requestEngagedMembership([2, 3]); // 2 is a dup
    requestEngagedMembership([3, 4]);
    runFlush();
    await settle();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].modelIds.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    // result folded into the store
    expect(useEngagedModelsStore.getState().membership[2]?.has('Recommended')).toBe(true);
    expect(useEngagedModelsStore.getState().queried.has(4)).toBe(true); // queried-not-engaged
  });

  it('does not re-query ids already known to the store', async () => {
    useEngagedModelsStore.getState().applyServerResult({}, [1, 2]); // 1,2 known
    requestEngagedMembership([1, 2, 3]);
    runFlush();
    await settle();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].modelIds).toEqual([3]); // only the unknown one
  });

  it('chunks a >200-id request into ≤200-id queries', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    requestEngagedMembership(ids);
    runFlush();
    await settle();
    expect(queryMock).toHaveBeenCalledTimes(3); // 200 + 200 + 50
    expect(queryMock.mock.calls.map((c) => c[0].modelIds.length)).toEqual([200, 200, 50]);
  });

  it('leaves ids unknown after a failed fetch so a later mount retries', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    requestEngagedMembership([5]);
    runFlush();
    await settle();
    expect(useEngagedModelsStore.getState().queried.has(5)).toBe(false); // still unknown

    // retry succeeds
    queryMock.mockResolvedValueOnce({ Recommended: [5] });
    requestEngagedMembership([5]);
    runFlush();
    await settle();
    expect(useEngagedModelsStore.getState().membership[5]?.has('Recommended')).toBe(true);
  });

  it('does nothing when every requested id is already known', async () => {
    useEngagedModelsStore.getState().applyServerResult({}, [1]);
    requestEngagedMembership([1]);
    // nothing scheduled (all known) → no flush callback captured
    expect(scheduledFlush).toBeNull();
    runFlush();
    await settle();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('ignores non-positive ids', async () => {
    requestEngagedMembership([0, -1]);
    expect(scheduledFlush).toBeNull();
    runFlush();
    await settle();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------
function renderHook<T>(useCb: () => T) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const ref: { current: T | undefined } = { current: undefined };
  function Probe() {
    ref.current = useCb();
    return null;
  }
  act(() => root.render(React.createElement(Probe)));
  return {
    result: ref,
    rerender: () => act(() => root.render(React.createElement(Probe))),
    unmount: () => act(() => root.unmount()),
  };
}

describe('useEngagedModelsMembership hook', () => {
  it('unauthenticated → no query is issued', async () => {
    currentUser = null;
    const { unmount } = renderHook(() => useEngagedModelsMembership([1, 2]));
    runFlush();
    await settle();
    expect(queryMock).not.toHaveBeenCalled();
    unmount();
  });

  it('authed → registers the on-screen ids and issues one query', async () => {
    queryMock.mockResolvedValue({ Recommended: [1] });
    const { result, rerender, unmount } = renderHook(() => useEngagedModelsMembership([1, 2]));
    runFlush();
    await settle();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].modelIds.slice().sort((a, b) => a - b)).toEqual([1, 2]);

    rerender();
    expect(result.current?.isEngaged(1, 'Recommended')).toBe(true);
    expect(result.current?.isEngaged(2, 'Recommended')).toBe(false);
    expect(result.current?.isLoading).toBe(false);
    unmount();
  });

  it('single-model wrapper reads membership reactively', async () => {
    queryMock.mockResolvedValue({ Notify: [9] });
    const { result, rerender, unmount } = renderHook(() => useEngagedModelMembership(9));
    runFlush();
    await settle();
    rerender();
    expect(result.current?.isEngaged('Notify')).toBe(true);
    expect(result.current?.isEngaged('Mute')).toBe(false);
    unmount();
  });

  it('ignores a non-positive id (loading-guard for not-yet-loaded models)', async () => {
    const { result, unmount } = renderHook(() => useEngagedModelMembership(0));
    runFlush();
    await settle();
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.current?.isEngaged('Recommended')).toBe(false);
    unmount();
  });
});
