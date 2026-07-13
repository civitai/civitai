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

// ============================================================================
// `case 'images'` branch — the content-safety filter the gallery's LAZY per-post
// carousel re-applies to its fetched tail (`useApplyHiddenPreferences({ type:
// 'images' })` in `LazyPostImagesCarousel`, #3071). #3071 shipped this branch
// UNTESTED — the browser test stubbed the hook to identity, so it would have
// passed even if the filter were deleted. These pin the REAL pure filter so a
// hidden image can never silently leak into the lazily-loaded tail.
// ============================================================================

type ImgOverrides = Partial<{
  id: number;
  userId: number;
  nsfwLevel: number;
  tagIds: number[];
  poi: boolean;
  minor: boolean;
  prompt: string;
}>;

// A single browsing-visible image (nsfwLevel 1 intersects BROWSING_LEVEL 1). Each
// override flips exactly one drop dimension so a failing case isolates one rule.
const makeImage = (o: ImgOverrides = {}) => ({
  id: o.id ?? nextId++,
  userId: o.userId ?? 9999,
  nsfwLevel: o.nsfwLevel ?? 1,
  tagIds: o.tagIds ?? [],
  poi: o.poi ?? false,
  minor: o.minor ?? false,
  prompt: o.prompt ?? '',
});

const prefsWith = (
  o: Partial<{ images: number[]; users: number[]; tags: number[]; systemTags: number[] }> = {}
): HiddenPreferencesState => ({
  ...emptyPrefs(),
  hiddenImages: new Map((o.images ?? []).map((id): [number, boolean] => [id, true])),
  hiddenUsers: new Map((o.users ?? []).map((id): [number, boolean] => [id, true])),
  hiddenTags: new Map((o.tags ?? []).map((id): [number, boolean] => [id, true])),
  systemHiddenTags: new Map((o.systemTags ?? []).map((id): [number, boolean] => [id, true])),
});

type RunImagesOpts = {
  hiddenPreferences?: HiddenPreferencesState;
  poiDisabled?: boolean;
  minorDisabled?: boolean;
  currentUser?: unknown;
  browsingLevel?: number;
};
const runImages = (data: ReturnType<typeof makeImage>[], opts: RunImagesOpts = {}) =>
  filterPreferences({
    type: 'images',
    data,
    hiddenPreferences: opts.hiddenPreferences ?? emptyPrefs(),
    browsingLevel: opts.browsingLevel ?? BROWSING_LEVEL,
    currentUser: (opts.currentUser ?? null) as never,
    canViewNsfw: true,
    poiDisabled: opts.poiDisabled ?? false,
    minorDisabled: opts.minorDisabled ?? false,
  });

describe("filterPreferences — 'images' branch drops every hidden dimension (lazy-tail safety)", () => {
  it('keeps a browsing-visible image untouched', () => {
    const { items } = runImages([makeImage({ id: 1 })]);
    expect(items.map((i) => i.id)).toEqual([1]);
  });

  // [label, the-image-that-must-drop, filter opts]. Each pairs the dirty image with
  // a clean sibling (id 1) and asserts the clean one survives while the dirty drops.
  const cases: Array<
    [
      string,
      ReturnType<typeof makeImage>,
      RunImagesOpts,
      keyof ReturnType<typeof runImages>['hidden']
    ]
  > = [
    ['browsing-level mismatch', makeImage({ id: 2, nsfwLevel: 2 }), {}, 'browsingLevel'],
    [
      'hidden image id',
      makeImage({ id: 3 }),
      { hiddenPreferences: prefsWith({ images: [3] }) },
      'images',
    ],
    [
      'hidden user',
      makeImage({ id: 4, userId: 555 }),
      { hiddenPreferences: prefsWith({ users: [555] }) },
      'users',
    ],
    [
      'hidden tag',
      makeImage({ id: 5, tagIds: [88] }),
      { hiddenPreferences: prefsWith({ tags: [88] }) },
      'tags',
    ],
    [
      'system hidden tag',
      makeImage({ id: 6, tagIds: [77] }),
      { hiddenPreferences: prefsWith({ systemTags: [77] }) },
      'tags',
    ],
    ['poi (disablePoi)', makeImage({ id: 7, poi: true }), { poiDisabled: true }, 'poi'],
  ];

  it.each(cases)('drops a %s image and keeps the clean sibling', (_label, dirty, opts, counter) => {
    const { items, hidden } = runImages([makeImage({ id: 1 }), dirty], opts);
    const ids = items.map((i) => i.id);
    expect(ids).toContain(1); // the clean image survives
    expect(ids).not.toContain(dirty.id); // the hidden one is filtered out
    expect(hidden[counter]).toBe(1); // …and attributed to the right dimension
  });

  it('does NOT drop a poi/minor image when the respective toggle is OFF', () => {
    const { items } = runImages([makeImage({ id: 9, poi: true, minor: true })], {
      poiDisabled: false,
      minorDisabled: false,
    });
    expect(items.map((i) => i.id)).toEqual([9]);
  });

  // disableMinor drops a minor image ONLY when it is also mature (nsfwLevel outside
  // {PG, PG-13}); SFW-minor stays visible. MATURE_LEVEL = PG|R so both a PG (SFW) and an
  // R (mature) minor image clear the browsing-level gate and reach the minor check.
  const MATURE_LEVEL = 1 | 4;

  it('drops a MATURE minor image when disableMinor is on', () => {
    const { items, hidden } = runImages(
      [makeImage({ id: 1, nsfwLevel: 4 }), makeImage({ id: 10, nsfwLevel: 4, minor: true })],
      { minorDisabled: true, browsingLevel: MATURE_LEVEL }
    );
    expect(items.map((i) => i.id)).toEqual([1]);
    expect(hidden.minor).toBe(1);
  });

  it('KEEPS an SFW minor image even when disableMinor is on', () => {
    const { items, hidden } = runImages([makeImage({ id: 11, nsfwLevel: 1, minor: true })], {
      minorDisabled: true,
      browsingLevel: MATURE_LEVEL,
    });
    expect(items.map((i) => i.id)).toEqual([11]);
    expect(hidden.minor).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Seed ↔ tail parity. The feed seed runs the `posts` per-image filter; the lazy
// carousel's tail runs the `images` filter. For the shared drop dimensions the
// `images` branch is a superset, so nothing the seed drops can reappear via the
// tail, and a tail-only image that clears the bar is admitted.
// ----------------------------------------------------------------------------
describe("seed ('posts') ↔ tail ('images') filter parity — no reappear-via-tail", () => {
  it('an image the posts-seed filter drops (hidden tag) is also dropped by the images tail', () => {
    const clean = makeImage({ id: 10 });
    const dirty = makeImage({ id: 11, tagIds: [42] });
    const hiddenTag = prefsWith({ tags: [42] });

    // Seed: the `posts` branch filters each post's images.
    const posts = filterPreferences({
      type: 'posts',
      data: [{ userId: 9999, nsfwLevel: 1, images: [clean, dirty] }],
      hiddenPreferences: hiddenTag,
      browsingLevel: BROWSING_LEVEL,
      currentUser: null as never,
      canViewNsfw: true,
    });
    expect(posts.items[0].images.map((i: { id: number }) => i.id)).toEqual([10]);

    // Tail: the same dirty image is dropped by the `images` branch.
    const tail = runImages([clean, dirty], { hiddenPreferences: hiddenTag });
    expect(tail.items.map((i) => i.id)).toEqual([10]);
  });

  it('a tail-only image that clears the bar survives the images filter', () => {
    const tailOnly = makeImage({ id: 12 });
    expect(runImages([tailOnly]).items.map((i) => i.id)).toEqual([12]);
  });
});
