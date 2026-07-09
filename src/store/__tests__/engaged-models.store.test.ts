import { afterEach, describe, expect, it } from 'vitest';
import {
  getEngagedModelTypes,
  isModelEngaged,
  isModelQueried,
  restoreMembership,
  snapshotMembership,
  useEngagedModelsStore,
} from '~/store/engaged-models.store';
import {
  applyFavoriteToggled,
  applyNotifyToggled,
  applyReviewCreated,
  applyReviewDeleted,
  applyReviewUpdated,
} from '~/store/engaged-models.optimistic';

const store = useEngagedModelsStore;

afterEach(() => {
  store.getState().reset();
});

// ---------------------------------------------------------------------------
// Store primitives
// ---------------------------------------------------------------------------
describe('engaged-models store — primitives', () => {
  it('setMembership on/off toggles a single type and marks the id known', () => {
    expect(isModelQueried(1)).toBe(false); // unknown

    store.getState().setMembership(1, 'Recommended', true);
    expect(isModelEngaged(1, 'Recommended')).toBe(true);
    expect(isModelQueried(1)).toBe(true); // now known

    store.getState().setMembership(1, 'Recommended', false);
    expect(isModelEngaged(1, 'Recommended')).toBe(false);
    expect(isModelQueried(1)).toBe(true); // still known (queried, not engaged)
  });

  it('supports multiple co-existing types on one model', () => {
    store.getState().setMembership(7, 'Recommended', true);
    store.getState().setMembership(7, 'Notify', true);
    expect(getEngagedModelTypes(7).sort()).toEqual(['Notify', 'Recommended']);
    expect(isModelEngaged(7, 'Recommended')).toBe(true);
    expect(isModelEngaged(7, 'Notify')).toBe(true);
    expect(isModelEngaged(7, 'Mute')).toBe(false);
  });

  it('distinguishes unknown / known-not-engaged / engaged', () => {
    // unknown
    expect(isModelQueried(3)).toBe(false);
    expect(isModelEngaged(3, 'Recommended')).toBe(false);

    // applyServerResult with the id absent from the record → known-not-engaged
    store.getState().applyServerResult({ Recommended: [] }, [3]);
    expect(isModelQueried(3)).toBe(true);
    expect(isModelEngaged(3, 'Recommended')).toBe(false);
  });

  it('applyServerResult marks ALL queried ids known even when absent from the record', () => {
    store.getState().applyServerResult({ Recommended: [10], Notify: [11] }, [10, 11, 12, 13]);
    // engaged
    expect(isModelEngaged(10, 'Recommended')).toBe(true);
    expect(isModelEngaged(11, 'Notify')).toBe(true);
    // queried-but-absent → known, not engaged
    expect(isModelQueried(12)).toBe(true);
    expect(isModelQueried(13)).toBe(true);
    expect(getEngagedModelTypes(12)).toEqual([]);
    expect(getEngagedModelTypes(13)).toEqual([]);
  });

  it('applyServerResult records an engaged id even if it was not in the queried list', () => {
    store.getState().applyServerResult({ Favorite: [99] }, [1]);
    expect(isModelEngaged(99, 'Favorite')).toBe(true);
    expect(isModelQueried(99)).toBe(true);
  });

  it('applyServerResult overwrites prior server truth for the same id', () => {
    store.getState().applyServerResult({ Recommended: [5] }, [5]);
    expect(isModelEngaged(5, 'Recommended')).toBe(true);
    store.getState().applyServerResult({ Recommended: [] }, [5]);
    expect(isModelEngaged(5, 'Recommended')).toBe(false);
  });

  it('setMembership keeps the state reference stable on a genuine no-op', () => {
    store.getState().applyServerResult({}, [4]); // known, empty
    const before = store.getState().membership;
    store.getState().setMembership(4, 'Recommended', false); // already absent + known
    expect(store.getState().membership).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Reactive selector subscription
// ---------------------------------------------------------------------------
describe('engaged-models store — reactivity', () => {
  it('notifies subscribers when a relevant membership changes', () => {
    const seen: boolean[] = [];
    const unsub = store.subscribe((s) => seen.push(s.membership[1]?.has('Recommended') ?? false));
    store.getState().setMembership(1, 'Recommended', true);
    store.getState().setMembership(1, 'Recommended', false);
    unsub();
    expect(seen).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// snapshot / restore
// ---------------------------------------------------------------------------
describe('engaged-models store — snapshot/restore', () => {
  it('snapshot is a detached clone; later mutations do not mutate it', () => {
    store.getState().setMembership(1, 'Recommended', true);
    const snap = snapshotMembership(1);
    store.getState().setMembership(1, 'Notify', true);
    expect([...snap]).toEqual(['Recommended']); // unchanged
  });

  it('restore replaces the full type-set exactly', () => {
    store.getState().setMembership(1, 'Recommended', true);
    const snap = snapshotMembership(1);
    store.getState().setMembership(1, 'Notify', true);
    store.getState().setMembership(1, 'Recommended', false);
    restoreMembership(1, snap);
    expect(getEngagedModelTypes(1)).toEqual(['Recommended']);
    expect(isModelEngaged(1, 'Notify')).toBe(false);
  });
});
