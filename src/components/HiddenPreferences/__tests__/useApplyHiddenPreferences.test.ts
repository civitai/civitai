import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the telemetry sink so the filter's aggregate emit is observable without touching Faro.
vi.mock('~/utils/faro/feedDrop', () => ({ emitFeedNoImagesDrop: vi.fn() }));

import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type { HiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { emitFeedNoImagesDrop } from '~/utils/faro/feedDrop';

/**
 * Covers the browsing-level feed-drop instrumentation wired into the `case 'models'` branch:
 * the filter emits exactly ONE aggregate telemetry event per call (never per dropped model),
 * carrying the per-page `{ droppedNoImages, total, browsingLevel }` counts. The emit/sampling/
 * shape contract itself is covered in `~/utils/faro/__tests__/feedDrop.test.ts`.
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

describe('filterPreferences — models browsing-level drop instrumentation', () => {
  beforeEach(() => {
    vi.mocked(emitFeedNoImagesDrop).mockClear();
    nextId = 1;
  });

  it('emits ONE aggregate event with droppedNoImages=M, total=N (not one per dropped model)', () => {
    // 5 models in, 2 drop for noImages, 3 survive.
    const models = [
      makeModel('keep'),
      makeModel('drop'),
      makeModel('keep'),
      makeModel('drop'),
      makeModel('keep'),
    ];

    const { items, hidden } = runModels(models);

    // sanity: the filter itself dropped 2 and kept 3
    expect(hidden.noImages).toBe(2);
    expect(items).toHaveLength(3);

    // exactly ONE emit for the whole page — proves it is aggregate, not per dropped model
    expect(emitFeedNoImagesDrop).toHaveBeenCalledTimes(1);
    expect(emitFeedNoImagesDrop).toHaveBeenCalledWith({
      droppedNoImages: 2,
      total: 5,
      browsingLevel: BROWSING_LEVEL,
    });
  });

  it('still emits exactly once (droppedNoImages=0) when nothing drops — gating is delegated to the sink', () => {
    // The M===0 "stay silent" decision lives in emitFeedNoImagesDrop (mocked here); the filter
    // always makes exactly one aggregate call, so there is no per-model emit path to regress.
    const { hidden } = runModels([makeModel('keep'), makeModel('keep')]);

    expect(hidden.noImages).toBe(0);
    expect(emitFeedNoImagesDrop).toHaveBeenCalledTimes(1);
    expect(emitFeedNoImagesDrop).toHaveBeenCalledWith({
      droppedNoImages: 0,
      total: 2,
      browsingLevel: BROWSING_LEVEL,
    });
  });
});
