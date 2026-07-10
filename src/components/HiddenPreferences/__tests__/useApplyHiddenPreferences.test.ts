// @vitest-environment happy-dom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the telemetry sink so the emit is observable without touching Faro. After the
// render-purity fix the emit no longer fires from `filterPreferences` (render phase) — it
// fires from the hook's commit `useEffect`. These tests pin both halves of that contract.
vi.mock('~/utils/faro/feedDrop', () => ({ emitFeedNoImagesDrop: vi.fn() }));

// The hook pulls its inputs from five React contexts. Stub them so the hook can render in
// isolation (node + happy-dom) — `filterPreferences` itself takes everything as explicit args
// and needs none of these mocks. browsingLevel = 1 (a single-bit "SFW" level) mirrors the
// pure-filter setup below.
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', () => ({
  useHiddenPreferencesContext: () => ({
    hiddenUsers: new Map(),
    hiddenTags: new Map(),
    hiddenModels: new Map(),
    hiddenModel3Ds: new Map(),
    hiddenImages: new Map(),
    hiddenLoading: false,
    moderatedTags: [],
    systemHiddenTags: new Map(),
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  useBrowsingSettingsAddons: () => ({ settings: { disablePoi: false, disableMinor: false } }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: true }),
}));

import {
  filterPreferences,
  useApplyHiddenPreferences,
} from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type { HiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { emitFeedNoImagesDrop } from '~/utils/faro/feedDrop';

/**
 * Covers the browsing-level feed-drop instrumentation for the `case 'models'` branch AND the
 * render-purity fix (fast-follow to #3037): the emit was moved out of the render-phase memo
 * into a commit `useEffect`.
 *
 *  - `filterPreferences` is now PURE: it RETURNS the aggregate `{ droppedNoImages, total,
 *    browsingLevel }` drop-metadata for the models page and NEVER calls the telemetry sink.
 *  - `useApplyHiddenPreferences` emits exactly ONE aggregate event per commit (never per
 *    dropped model) from an effect, gated on a real drop. The emit/sampling/shape contract
 *    itself is covered in `~/utils/faro/__tests__/feedDrop.test.ts`.
 *
 * Setup: browsingLevel = 1 (a single-bit "SFW" level). A model row with `nsfwLevel: 1` passes
 * the row gate; its images are then kept iff `nsfwLevel & 1 !== 0`. So an image of `nsfwLevel: 2`
 * is filtered out — a model whose ONLY image is `nsfwLevel: 2` drops for `noImages`.
 */

const BROWSING_LEVEL = 1;

const emptyPrefs = (): HiddenPreferencesState => ({
  hiddenUsers: new Map(),
  hiddenTags: new Map(),
  hiddenModels: new Map(),
  hiddenModel3Ds: new Map(),
  hiddenImages: new Map(),
  hiddenLoading: false,
  moderatedTags: [],
  systemHiddenTags: new Map(),
});

let nextId = 1;
/** A model that KEEPS (has a browsing-safe image) or DROPS (only unsafe images). */
const makeModel = (kind: 'keep' | 'drop') => ({
  id: nextId++,
  user: { id: 9999 },
  nsfwLevel: 1, // intersects browsingLevel → row passes the browsing-level gate
  nsfw: false,
  name: 'm',
  images: [{ id: nextId++, nsfwLevel: kind === 'keep' ? 1 : 2 }],
});

const runModels = (models: ReturnType<typeof makeModel>[]) =>
  filterPreferences({
    type: 'models',
    data: models,
    hiddenPreferences: emptyPrefs(),
    browsingLevel: BROWSING_LEVEL,
    currentUser: null as never,
    canViewNsfw: true,
  });

// Minimal renderHook (no @testing-library/react in this repo): render a null component that
// calls the hook, driven under React 18 `act` so commit effects flush. happy-dom supplies the
// DOM `createRoot` needs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe() {
    result.current = useHook();
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return { result, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  vi.mocked(emitFeedNoImagesDrop).mockClear();
  nextId = 1;
});

describe('filterPreferences — models drop metadata is PURE (no telemetry side-effect)', () => {
  it('returns aggregate feedDrop { droppedNoImages=M, total=N } and does NOT call the sink', () => {
    // 5 models in, 2 drop for noImages, 3 survive.
    const models = [
      makeModel('keep'),
      makeModel('drop'),
      makeModel('keep'),
      makeModel('drop'),
      makeModel('keep'),
    ];

    const { items, hidden, feedDrop } = runModels(models);

    // sanity: the filter itself dropped 2 and kept 3
    expect(hidden.noImages).toBe(2);
    expect(items).toHaveLength(3);

    // the drop-metadata is RETURNED (aggregate, per page — not per dropped model)…
    expect(feedDrop).toEqual({
      droppedNoImages: 2,
      total: 5,
      browsingLevel: BROWSING_LEVEL,
    });
    // …and the side-effect is GONE from render: the filter never touches the sink.
    expect(emitFeedNoImagesDrop).not.toHaveBeenCalled();
  });

  it('still returns feedDrop (droppedNoImages=0) when nothing drops — the M=0 gate lives downstream', () => {
    const { hidden, feedDrop } = runModels([makeModel('keep'), makeModel('keep')]);

    expect(hidden.noImages).toBe(0);
    expect(feedDrop).toEqual({ droppedNoImages: 0, total: 2, browsingLevel: BROWSING_LEVEL });
    expect(emitFeedNoImagesDrop).not.toHaveBeenCalled();
  });
});

describe('useApplyHiddenPreferences — feed-drop emit fires from the commit effect', () => {
  it('emits exactly ONE aggregate event when a page drops M>0 models', () => {
    const models = [
      makeModel('keep'),
      makeModel('drop'),
      makeModel('keep'),
      makeModel('drop'),
      makeModel('keep'),
    ];

    const { unmount } = renderHook(() =>
      useApplyHiddenPreferences({ type: 'models', data: models })
    );

    expect(emitFeedNoImagesDrop).toHaveBeenCalledTimes(1);
    expect(emitFeedNoImagesDrop).toHaveBeenCalledWith({
      droppedNoImages: 2,
      total: 5,
      browsingLevel: BROWSING_LEVEL,
    });

    unmount();
  });

  it('is silent when M=0 (no page drop → the effect never calls the sink)', () => {
    const { unmount } = renderHook(() =>
      useApplyHiddenPreferences({ type: 'models', data: [makeModel('keep'), makeModel('keep')] })
    );

    expect(emitFeedNoImagesDrop).not.toHaveBeenCalled();

    unmount();
  });
});
