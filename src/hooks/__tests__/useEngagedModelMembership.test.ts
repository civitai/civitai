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
import { applyNotifyToggled } from '~/store/engaged-models.optimistic';

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

  it('marks ids known-not-engaged after a failed fetch so a gated control is never permanently disabled (F2)', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    requestEngagedMembership([5]);
    runFlush();
    await settle();

    // Fix 2: the errored ids become KNOWN (empty membership), not left unknown. A
    // component that stays mounted (deps unchanged → effect never re-fires) would
    // otherwise never re-request them, leaving its `disabled = !isKnown` control dead.
    expect(useEngagedModelsStore.getState().queried.has(5)).toBe(true);
    expect(useEngagedModelsStore.getState().membership[5]?.size ?? 0).toBe(0); // known-not-engaged

    // Now-known → a subsequent request is a no-op (no refetch storm).
    queryMock.mockClear();
    requestEngagedMembership([5]);
    runFlush();
    await settle();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('a failed fetch does NOT clobber an id the user mutated while it was in flight (F2 dirty-guard holds through the error path)', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    requestEngagedMembership([8]);
    runFlush(); // fetch issued; .then/.catch queued but not yet run

    // User turns Notify ON for model 8 WHILE that fetch is in flight.
    useEngagedModelsStore.getState().setMembership(8, 'Notify', true);

    await settle(); // the rejection lands here → applyServerResult({}, [8])

    const m = useEngagedModelsStore.getState().membership[8];
    expect(m?.has('Notify')).toBe(true); // the local mutation survived the error-path apply
    expect(useEngagedModelsStore.getState().queried.has(8)).toBe(true);
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
    expect(result.current?.isKnown).toBe(false); // an unloaded model is never "known"
    unmount();
  });
});

// ---------------------------------------------------------------------------
// F1 — known-gating: controls that compute a toggle direction from membership
// must be able to tell "unknown" from "not engaged" so they can block the click
// until the store is warm for this model (the regression this PR revision fixes).
// ---------------------------------------------------------------------------
describe('useEngagedModelMembership — known-gating (F1)', () => {
  it('single-model: isKnown=false while the fetch is in flight, then true (and ON) once it lands', async () => {
    queryMock.mockResolvedValue({ Notify: [42] });
    const { result, rerender, unmount } = renderHook(() => useEngagedModelMembership(42));

    // Fetch registered but not yet resolved → the model is UNKNOWN. A cold store
    // reads not-engaged, so a control MUST gate on isKnown here (not isEngaged).
    expect(result.current?.isKnown).toBe(false);
    expect(result.current?.isLoading).toBe(true);
    expect(result.current?.isEngaged('Notify')).toBe(false);

    runFlush();
    await settle();
    rerender();

    // Now known and reflecting the true ON state.
    expect(result.current?.isKnown).toBe(true);
    expect(result.current?.isLoading).toBe(false);
    expect(result.current?.isEngaged('Notify')).toBe(true);
    unmount();
  });

  it('multi-model: isKnown is per-id — queried-not-engaged still counts as known', async () => {
    queryMock.mockResolvedValue({ Recommended: [1] }); // 1 engaged, 2 absent
    const { result, rerender, unmount } = renderHook(() => useEngagedModelsMembership([1, 2]));

    expect(result.current?.isKnown(1)).toBe(false);
    expect(result.current?.isKnown(2)).toBe(false);

    runFlush();
    await settle();
    rerender();

    expect(result.current?.isKnown(1)).toBe(true);
    expect(result.current?.isKnown(2)).toBe(true); // known-not-engaged, not "unknown"
    expect(result.current?.isEngaged(1, 'Recommended')).toBe(true);
    expect(result.current?.isEngaged(2, 'Recommended')).toBe(false);
    unmount();
  });

  it('an optimistic write makes the model known immediately (no fetch needed)', async () => {
    const { result, rerender, unmount } = renderHook(() => useEngagedModelMembership(15));
    expect(result.current?.isKnown).toBe(false);

    // A control's optimistic mutation marks the id known via the store.
    act(() => {
      useEngagedModelsStore.getState().setMembership(15, 'Notify', true);
    });
    rerender();

    expect(result.current?.isKnown).toBe(true);
    expect(result.current?.isEngaged('Notify')).toBe(true);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// F2 — a real in-flight-fetch-races-a-mutation path through the batcher: the
// optimistic write must survive the (now-stale) server result landing on top.
// ---------------------------------------------------------------------------
describe('useEngagedModelsMembership — mutation-races-fetch (F2)', () => {
  it('optimistic write during the in-flight fetch is not clobbered by the stale result', async () => {
    // The server snapshot predates the user's mutation: it says Recommended, NOT Notify.
    queryMock.mockResolvedValue({ Recommended: [7] });
    const { unmount } = renderHook(() => useEngagedModelsMembership([7]));

    runFlush(); // issues the fetch (promise created; .then queued but not yet run)

    // User turns Notify ON for model 7 WHILE that fetch is in flight.
    act(() => {
      useEngagedModelsStore.getState().setMembership(7, 'Notify', true);
    });

    await settle(); // the now-stale fetch result lands here

    const m = useEngagedModelsStore.getState().membership[7];
    expect(m?.has('Notify')).toBe(true); // the user's intent is preserved…
    expect(m?.has('Recommended')).toBe(false); // …and the stale snapshot was skipped
    expect(useEngagedModelsStore.getState().queried.has(7)).toBe(true); // consistent/known
    unmount();
  });
});

// ---------------------------------------------------------------------------
// F1 (unauth) — a logged-out user has no membership to toggle wrongly. `isKnown`
// must be true so a gated control (`disabled = loading = !isKnown`) stays
// INTERACTIVE — a disabled element can't fire the LoginRedirect click that
// prompts sign-in. This is the login/conversion-funnel regression the re-audit
// caught (isKnown was FALSE FOREVER for logged-out users → notify bell dead).
// ---------------------------------------------------------------------------

/**
 * Mirror of the migrated notify controls' gating so we can assert the actual
 * `disabled` DOM state the user sees, driven by the REAL hook. The control does
 * `loading={mutation.isPending || !isKnown}`; Mantine then sets
 * `disabled = disabled || loading`. Mutation is idle here (isPending=false), so
 * the button is disabled iff `!isKnown`.
 */
function NotifyControlHarness({ modelId }: { modelId: number }) {
  const { isKnown } = useEngagedModelMembership(modelId);
  const isPending = false;
  const loading = isPending || !isKnown;
  const disabled = loading; // Mantine: disabled = disabled || loading
  return React.createElement('button', { type: 'button', disabled }, 'notify');
}

function renderControl(modelId: number) {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(React.createElement(NotifyControlHarness, { modelId })));
  return {
    button: () => container.querySelector('button') as HTMLButtonElement,
    rerender: () => act(() => root.render(React.createElement(NotifyControlHarness, { modelId }))),
    unmount: () => act(() => root.unmount()),
  };
}

describe('useEngagedModelMembership — unauthenticated (F1 login-funnel regression)', () => {
  it('single-model: isKnown is TRUE with no currentUser (nothing to gate) — no query issued', async () => {
    currentUser = null;
    const { result, unmount } = renderHook(() => useEngagedModelMembership(42));
    runFlush();
    await settle();
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.current?.isKnown).toBe(true);
    expect(result.current?.isLoading).toBe(false);
    unmount();
  });

  it('multi-model: isKnown(id) is TRUE for every id with no currentUser', async () => {
    currentUser = null;
    const { result, unmount } = renderHook(() => useEngagedModelsMembership([1, 2, 3]));
    runFlush();
    await settle();
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.current?.isKnown(1)).toBe(true);
    expect(result.current?.isKnown(2)).toBe(true);
    expect(result.current?.isKnown(3)).toBe(true);
    unmount();
  });

  it("a logged-out notify control is NOT disabled → its click can reach LoginRedirect", () => {
    currentUser = null;
    const { button, unmount } = renderControl(99);
    // The store is cold (no query ever fires for unauth), yet the button is enabled
    // because isKnown short-circuits to true. A disabled button would swallow the
    // click that LoginRedirect clones onto it — this is the funnel fix.
    expect(button().disabled).toBe(false);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// F2 (authed + fetch error) — the gated control must not dead-lock. After the
// by-ids fetch rejects, the control becomes actionable rather than staying a
// permanent infinite-spinner disabled button.
// ---------------------------------------------------------------------------
describe('useEngagedModelMembership — authed fetch error does not dead-lock the control (F2)', () => {
  it('authed control is disabled while the fetch is in flight, then ENABLED after the fetch errors', async () => {
    currentUser = { id: 1 };
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const { button, rerender, unmount } = renderControl(77);

    // In flight → unknown → disabled (correct: we don't know the toggle direction yet).
    expect(button().disabled).toBe(true);

    runFlush();
    await settle();
    rerender();

    // Fetch errored → Fix 2 marks it known-not-engaged → control is actionable again,
    // not a permanently-disabled dead button.
    expect(button().disabled).toBe(false);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Silent-unsubscribe fix (audit fast-follow to the #3034 error path).
//
// The #3034 error path marks a genuinely Notify-ON model known-not-engaged when
// its by-ids read errors (so the gated control un-sticks). The OLD notify
// mutation then sent `type: isOn ? Mute : undefined` — an UNDEFINED type on the
// subscribe click → the server BLIND-toggled and DELETED the existing Notify
// (silent unsubscribe), while `onMutate` optimistically wrote Notify=true → the
// store was left LYING (ON on the client, OFF on the server).
//
// The fix carries an EXPLICIT `setTo` derived from the button intent, so the
// click that lands on a fabricated-off (but genuinely-ON) model is an idempotent
// subscribe, never a delete — and the optimistic write matches the guaranteed
// server outcome. This harness replicates the REAL control's click derivation
// (isOn + payload + onMutate optimistic) on top of the REAL hook/store/optimistic
// modules; the server half (setTo:true never deletes) is pinned in
// server/services/__tests__/engagement-toggle.idempotent.service.test.ts.
// ---------------------------------------------------------------------------

interface NotifyPayload {
  modelId: number;
  type: 'Notify' | 'Mute' | undefined;
  setTo?: boolean;
}

/**
 * Faithful replica of ToggleModelNotification's click path (following=[] → not
 * following the creator). Captures the payload the control would `.mutate()` and
 * runs the same `onMutate` optimistic write.
 */
function NotifyClickHarness({
  modelId,
  onPayload,
}: {
  modelId: number;
  onPayload: (p: NotifyPayload) => void;
}) {
  const { isEngaged, isKnown } = useEngagedModelMembership(modelId);
  const isWatching = isEngaged('Notify');
  const isMuted = isEngaged('Mute');
  const isOn = isWatching && !isMuted; // not following the creator in this harness

  const onClick = () => {
    if (!isKnown) return;
    const payload: NotifyPayload = {
      modelId,
      type: isOn ? 'Mute' : 'Notify',
      setTo: true,
    };
    // onMutate optimistic write (mirrors the mutation's onMutate).
    applyNotifyToggled(modelId, !isOn);
    onPayload(payload);
  };

  return React.createElement(
    'button',
    { type: 'button', disabled: !isKnown, onClick },
    'notify'
  );
}

describe('notify silent-unsubscribe fix — genuinely-ON model whose by-ids read errored', () => {
  it('click on the (fabricated-off) bell sends an EXPLICIT subscribe (type=Notify, setTo=true) — never a blind toggle — and the store does not end up lying', async () => {
    currentUser = { id: 1 };
    const modelId = 55;
    // The by-ids read for this genuinely Notify-ON model ERRORS.
    queryMock.mockRejectedValueOnce(new Error('boom'));

    let captured: NotifyPayload | undefined;
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        React.createElement(NotifyClickHarness, { modelId, onPayload: (p) => (captured = p) })
      )
    );

    // In flight → unknown → disabled.
    const button = () => container.querySelector('button') as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    runFlush();
    await settle();
    act(() =>
      root.render(
        React.createElement(NotifyClickHarness, { modelId, onPayload: (p) => (captured = p) })
      )
    );

    // #3034 error path: id is now known-not-engaged (fabricated OFF) → control enabled,
    // and the store reads Notify as absent even though the server row IS Notify.
    expect(button().disabled).toBe(false);
    expect(useEngagedModelsStore.getState().queried.has(modelId)).toBe(true);
    expect(useEngagedModelsStore.getState().membership[modelId]?.has('Notify')).toBe(false);

    // User clicks the bell (intending to subscribe).
    act(() => button().click());

    // 1) The payload carries EXPLICIT direction — a subscribe, not a blind toggle.
    //    (The old bug sent `type: undefined` here → server-side blind DELETE.)
    expect(captured).toBeDefined();
    expect(captured?.type).toBe('Notify');
    expect(captured?.setTo).toBe(true);
    expect(captured?.type).not.toBeUndefined();

    // 2) The optimistic write leaves the store showing Notify=ON. Because setTo:true
    //    on an existing Notify is a no-op subscribe server-side (pinned in the service
    //    test), the server is ALSO ON — store == server, so the UI is not left lying.
    const m = useEngagedModelsStore.getState().membership[modelId];
    expect(m?.has('Notify')).toBe(true);
    expect(m?.has('Mute')).toBe(false);

    act(() => root.unmount());
  });
});
