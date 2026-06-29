import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — the store transitively imports trpc + several other zustand
// stores that pull localStorage / next / etc. None of those are relevant to
// the funnel-attribution logic under test, so stub them out with minimal
// stand-ins. Anything *not* mocked here is exercised for real (zustand /
// immer / the store module itself).
// ---------------------------------------------------------------------------

// trpc: only `generation.getGenerationData.query` is referenced from the store.
// `fetchGenerationData` is the seam — tests override it directly via
// vi.mock returning a controllable Promise per test.
const fetchMock = vi.fn();
vi.mock('~/utils/trpc', () => ({
  trpcVanilla: {
    generation: {
      getGenerationData: {
        query: (...args: unknown[]) => fetchMock(...args),
      },
    },
  },
}));

// Panel store: only opened/view/previousView are touched, no setState side
// effects matter to the funnel attribution logic.
vi.mock('~/store/generation-panel.store', () => ({
  useGenerationPanelStore: {
    setState: vi.fn(),
    getState: () => ({ view: 'generate', opened: false, previousView: undefined }),
  },
}));

// Remix store: touches localStorage on import via the persist middleware.
// Stub it out to avoid needing a DOM in the test env.
vi.mock('~/store/remix.store', () => ({
  remixStore: {
    setRemix: vi.fn(),
    clearRemix: vi.fn(),
    getData: () => null,
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

// Imported after mocks are declared above (vitest hoists vi.mock calls).
import { useGenerationGraphStore } from '~/store/generation-graph.store';

function resetStore() {
  useGenerationGraphStore.setState({
    counter: 0,
    loading: false,
    data: undefined,
    lastEntryAction: 'direct',
    openSequence: 0,
  });
  fetchMock.mockReset();
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore();
});

describe('useGenerationGraphStore — funnel attribution', () => {
  it('starts with lastEntryAction = direct', () => {
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('direct');
  });

  it("open() with no input keeps lastEntryAction = 'direct' (no in-flight data)", async () => {
    await useGenerationGraphStore.getState().open();
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('direct');
  });

  it("open({type:'image', id:1}) resolves to lastEntryAction = 'remix'", async () => {
    fetchMock.mockResolvedValueOnce({
      resources: [],
      params: {},
      remixOfId: undefined,
    });
    await useGenerationGraphStore.getState().open({ type: 'image', id: 1 } as any);
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');
  });

  it("open({type:'modelVersion', id:42}) resolves to lastEntryAction = 'create'", async () => {
    fetchMock.mockResolvedValueOnce({
      resources: [],
      params: {},
      remixOfId: undefined,
    });
    await useGenerationGraphStore.getState().open({ type: 'modelVersion', id: 42 } as any);
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('create');
  });

  it("open({type:'wildcard'}) resolves to lastEntryAction = 'create'", async () => {
    await useGenerationGraphStore.getState().open({ type: 'wildcard', wildcardSetId: 7 });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('create');
  });

  it("setData({runType:'run'}) sets lastEntryAction = 'create'", () => {
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'run' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('create');
  });

  it("setData({runType:'remix'}) sets lastEntryAction = 'remix'", () => {
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'remix' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');
  });

  it("setData({runType:'replay'}) sets lastEntryAction = 'replay'", () => {
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'replay' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('replay');
  });

  // ----------- REGRESSION GUARDS -----------------------------------------

  it("REGRESSION: setData({runType:'patch'}) preserves lastEntryAction", () => {
    // First establish a non-default attribution.
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'remix' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');

    // patch is a mid-session sub-flow; it MUST NOT overwrite attribution.
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'patch' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');
  });

  it("REGRESSION: setData({runType:'append'}) preserves lastEntryAction", () => {
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'remix' });
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'append' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');
  });

  it('REGRESSION: clearData() preserves lastEntryAction (form-provider race fix)', () => {
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'remix' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');

    // clearData runs at open-time, BEFORE the user clicks Generate.
    // It must NOT touch lastEntryAction or the submit telemetry will see
    // the default 'direct' and lose its attribution to the entry click.
    useGenerationGraphStore.getState().clearData();
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');
    expect(useGenerationGraphStore.getState().data).toBeUndefined();
  });

  // ----------- SESSION-END -----------------------------------------------

  it("close() resets lastEntryAction = 'direct'", () => {
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'remix' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');

    useGenerationGraphStore.getState().close();
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('direct');
  });

  // ----------- CONCURRENT OPEN RACE --------------------------------------

  it("concurrent open() race: later open's attribution wins, earlier fetch is discarded", async () => {
    // Open A: image remix — fetch deferred via a manually-resolvable promise.
    let resolveA: (v: unknown) => void = () => undefined;
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    fetchMock.mockReturnValueOnce(pendingA);

    const openAPromise = useGenerationGraphStore
      .getState()
      .open({ type: 'image', id: 100 } as any);

    // Open B: no-input navbar Create. Synchronous — runs to completion
    // before A's fetch resolves.
    await useGenerationGraphStore.getState().open();

    // Attribution mid-race: B has won synchronously, lastEntryAction = 'direct'.
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('direct');

    // Now resolve A's fetch — A's resolve path must detect the sequence bump
    // and NO-OP rather than clobber B's 'direct' with 'remix'.
    resolveA({ resources: [], params: {}, remixOfId: undefined });
    await openAPromise;

    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('direct');
  });

  it('concurrent open() race: failed earlier fetch does NOT reset attribution set by a later open', async () => {
    // Open A: image remix — fetch will REJECT.
    let rejectA: (e: unknown) => void = () => undefined;
    const pendingA = new Promise((_, reject) => {
      rejectA = reject;
    });
    fetchMock.mockReturnValueOnce(pendingA);

    const openAPromise = useGenerationGraphStore
      .getState()
      .open({ type: 'image', id: 200 } as any)
      .catch(() => undefined); // A's error must be swallowed by guard.

    // Open B: modelVersion → lastEntryAction = 'create'.
    fetchMock.mockResolvedValueOnce({ resources: [], params: {}, remixOfId: undefined });
    await useGenerationGraphStore.getState().open({ type: 'modelVersion', id: 999 } as any);

    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('create');

    // A rejects after B has won. The catch block in open() must see the
    // sequence mismatch and bail without resetting lastEntryAction to
    // 'direct'.
    rejectA(new Error('fetch aborted'));
    await openAPromise;

    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('create');
  });

  // ----------- LOADING-STUCK REGRESSION GUARDS ---------------------------

  it("REGRESSION: superseded resolve path clears loading when no-input open() runs in between", async () => {
    // Open A: image remix — fetch deferred via a manually-resolvable promise.
    // A sets loading=true on entry.
    let resolveA: (v: unknown) => void = () => undefined;
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    fetchMock.mockReturnValueOnce(pendingA);

    const openAPromise = useGenerationGraphStore
      .getState()
      .open({ type: 'image', id: 300 } as any);

    expect(useGenerationGraphStore.getState().loading).toBe(true);

    // Open B: no-input navbar Create. Synchronous — bumps openSequence
    // but does NOT touch loading on the legacy code path.
    await useGenerationGraphStore.getState().open();

    // Now resolve A's fetch. The bail-out must clear `loading` since B was
    // synchronous and didn't own it; otherwise consumers stay stuck on a
    // spinner until the next input-bearing open.
    resolveA({ resources: [], params: {}, remixOfId: undefined });
    await openAPromise;

    expect(useGenerationGraphStore.getState().loading).toBe(false);
  });

  it('REGRESSION: superseded reject path clears loading when no-input open() runs in between', async () => {
    let rejectA: (e: unknown) => void = () => undefined;
    const pendingA = new Promise((_, reject) => {
      rejectA = reject;
    });
    fetchMock.mockReturnValueOnce(pendingA);

    const openAPromise = useGenerationGraphStore
      .getState()
      .open({ type: 'image', id: 400 } as any)
      .catch(() => undefined);

    expect(useGenerationGraphStore.getState().loading).toBe(true);

    await useGenerationGraphStore.getState().open();

    rejectA(new Error('fetch aborted'));
    await openAPromise;

    expect(useGenerationGraphStore.getState().loading).toBe(false);
  });

  it('REGRESSION: superseded bail does NOT clear loading while a sibling fetch is still in flight', async () => {
    // Two pending input-bearing opens. A is superseded by B, but B's fetch
    // is still awaiting — the bail-out must leave `loading` as true so
    // consumers keep their spinner until B resolves.
    let resolveA: (v: unknown) => void = () => undefined;
    let resolveB: (v: unknown) => void = () => undefined;
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise((resolve) => {
      resolveB = resolve;
    });
    fetchMock.mockReturnValueOnce(pendingA).mockReturnValueOnce(pendingB);

    const openAPromise = useGenerationGraphStore
      .getState()
      .open({ type: 'image', id: 500 } as any);
    const openBPromise = useGenerationGraphStore
      .getState()
      .open({ type: 'image', id: 501 } as any);

    expect(useGenerationGraphStore.getState().loading).toBe(true);

    // A's fetch resolves first (it's superseded by B). Bail should leave
    // loading=true because B is still pending.
    resolveA({ resources: [], params: {}, remixOfId: undefined });
    await openAPromise;
    expect(useGenerationGraphStore.getState().loading).toBe(true);

    // Now B resolves — owns the success path, sets loading=false.
    resolveB({ resources: [], params: {}, remixOfId: undefined });
    await openBPromise;
    expect(useGenerationGraphStore.getState().loading).toBe(false);
  });

  // ----------- WILDCARD RACE ---------------------------------------------

  it("REGRESSION: wildcard open clears loading even when an image fetch is pending", async () => {
    // Open A: image remix — fetch deferred via a manually-resolvable promise.
    // A sets loading=true on entry and bumps inFlightFetchCount to 1.
    let resolveA: (v: unknown) => void = () => undefined;
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    fetchMock.mockReturnValueOnce(pendingA);

    const openAPromise = useGenerationGraphStore
      .getState()
      .open({ type: 'image', id: 600 } as any);

    expect(useGenerationGraphStore.getState().loading).toBe(true);

    // Open B: wildcard. Synchronous — bumps openSequence, clears loading
    // unconditionally (the synchronous-input branch claims `loading=false`
    // for the latest open), but does NOT decrement inFlightFetchCount (A
    // owns that). After B runs: loading=false, A still pending.
    await useGenerationGraphStore.getState().open({ type: 'wildcard', wildcardSetId: 11 });
    expect(useGenerationGraphStore.getState().loading).toBe(false);
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('create');

    // Resolve A's fetch. The bail-out detects the sequence mismatch and
    // since inFlightFetchCount drops to 0, it would also try to clear
    // loading — but loading is already false, so this should NO-OP cleanly.
    // Critically: loading must STAY false (not flip back to true).
    resolveA({ resources: [], params: {}, remixOfId: undefined });
    await openAPromise;

    expect(useGenerationGraphStore.getState().loading).toBe(false);
  });

  // ----------- CLEARDATA + OPEN ATTRIBUTION (NAVBAR SCENARIO) -----------

  it("REGRESSION: setData(remix) then open() with no input → lastEntryAction = 'direct'", async () => {
    // Simulate: user remixed an image (lastEntryAction='remix'), then
    // clicked the navbar Create button (no-input open). The no-input branch
    // must reset attribution to 'direct' so the next Generator_Submit
    // pairs to the navbar click, NOT the prior remix. This locks in the
    // docblock claim about navbar source pairing to fromAction='direct'.
    useGenerationGraphStore.getState().setData({ params: {}, resources: [], runType: 'remix' });
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');

    // clearData() preserves attribution per the form-provider race fix —
    // important so we know the 'direct' write below comes from open(),
    // not from clearData() incidentally resetting it.
    useGenerationGraphStore.getState().clearData();
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');

    // No-input open — should write 'direct'.
    await useGenerationGraphStore.getState().open();
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('direct');
  });

  // ----------- preserveEntryAction FLAG ----------------------------------

  it('REGRESSION: open({modelVersion}, {preserveEntryAction:true}) does NOT overwrite lastEntryAction', async () => {
    // Establish a remix attribution upstream (e.g. user entered via Remix).
    fetchMock.mockResolvedValueOnce({ resources: [], params: {}, remixOfId: undefined });
    await useGenerationGraphStore.getState().open({ type: 'image', id: 1 } as any);
    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');

    // Mid-session base-model swap from inside the generator. With the
    // preserveEntryAction flag, this MUST NOT clobber 'remix' to 'create'.
    fetchMock.mockResolvedValueOnce({ resources: [], params: {}, remixOfId: undefined });
    await useGenerationGraphStore
      .getState()
      .open({ type: 'modelVersion', id: 42 } as any, { preserveEntryAction: true });

    expect(useGenerationGraphStore.getState().lastEntryAction).toBe('remix');
  });
});
