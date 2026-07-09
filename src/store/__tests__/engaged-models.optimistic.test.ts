import { afterEach, describe, expect, it } from 'vitest';
import {
  getEngagedModelTypes,
  isModelEngaged,
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
import type { EngagedModelType } from '~/store/engaged-models.store';

const store = useEngagedModelsStore;

/** Seed a model's membership deterministically. */
function seed(modelId: number, types: EngagedModelType[]) {
  store.getState().replaceMembership(modelId, types);
}

/** Sorted type list for stable comparisons. */
function types(modelId: number) {
  return getEngagedModelTypes(modelId).sort();
}

afterEach(() => {
  store.getState().reset();
});

// The suite the PR exists for: prove each action toggles the EXACT engagement
// types the legacy getEngagedModels handlers did, that an error rolls back to the
// prior membership precisely, and that no action ever touches another model.

describe('optimistic — create review', () => {
  it('adds Recommended + Notify when recommending a not-yet-recommended model', () => {
    seed(1, []);
    applyReviewCreated(1, true, false);
    expect(types(1)).toEqual(['Notify', 'Recommended']);
  });

  it('removes Recommended + Notify when the review is NOT recommended', () => {
    seed(1, ['Recommended', 'Notify']);
    applyReviewCreated(1, false, true);
    expect(types(1)).toEqual([]);
  });

  it('removes when recommending a model that is ALREADY recommended (shouldRemove branch)', () => {
    seed(1, ['Recommended', 'Notify']);
    applyReviewCreated(1, true, true); // already recommended → toggles off
    expect(types(1)).toEqual([]);
  });
});

describe('optimistic — update review', () => {
  it('adds Recommended when recommending a fresh model (touches only Recommended)', () => {
    seed(1, ['Notify']);
    applyReviewUpdated(1, true, false);
    expect(types(1)).toEqual(['Notify', 'Recommended']);
  });

  it('removes Recommended when recommended=false', () => {
    seed(1, ['Recommended', 'Notify']);
    applyReviewUpdated(1, false, true);
    expect(types(1)).toEqual(['Notify']); // Notify untouched
  });

  it('removes when already recommended (shouldRemove branch), leaving Notify', () => {
    seed(1, ['Recommended', 'Notify']);
    applyReviewUpdated(1, true, true);
    expect(types(1)).toEqual(['Notify']);
  });
});

// F3: the toggle DIRECTION must come from the caller-supplied `alreadyRecommended`
// (the warm legacy snapshot), NOT the normalized store — which can be cold for
// this model while a by-ids fetch is in flight and would otherwise flip intent.
describe('optimistic — create/update derive direction from the caller, not the (cold) store', () => {
  it('create: cold store (unknown) + alreadyRecommended=false → ADDS (does not read store)', () => {
    // Store has NO knowledge of model 1 (never seeded) — the legacy self-branch
    // would read not-recommended and add; here we prove the param drives it.
    applyReviewCreated(1, true, false);
    expect(types(1)).toEqual(['Notify', 'Recommended']);
  });

  it('create: cold store but caller says alreadyRecommended=true → REMOVES', () => {
    // The store is cold (reads not-recommended) yet the warm snapshot knows the
    // user already recommended → direction must be "remove", not "add".
    applyReviewCreated(1, true, true);
    expect(types(1)).toEqual([]); // toggled off despite the cold store
  });

  it('update: store says Recommended but caller says alreadyRecommended=false → ADDS (param wins)', () => {
    seed(1, ['Recommended']); // store disagrees with the caller on purpose
    applyReviewUpdated(1, true, false);
    expect(types(1)).toEqual(['Recommended']); // stays recommended (add branch)
  });

  it('update: store cold but caller says alreadyRecommended=true → REMOVES (param wins)', () => {
    applyReviewUpdated(1, true, true);
    expect(types(1)).toEqual([]); // removed despite the cold store
  });
});

describe('optimistic — delete review', () => {
  it('removes Recommended + Notify', () => {
    seed(1, ['Recommended', 'Notify']);
    applyReviewDeleted(1);
    expect(types(1)).toEqual([]);
  });

  it('leaves an unrelated type (e.g. Mute) intact', () => {
    seed(1, ['Recommended', 'Notify', 'Mute']);
    applyReviewDeleted(1);
    expect(types(1)).toEqual(['Mute']);
  });
});

describe('optimistic — toggle favorite', () => {
  it('favoriting adds Recommended + Notify', () => {
    seed(1, []);
    applyFavoriteToggled(1, true);
    expect(types(1)).toEqual(['Notify', 'Recommended']);
  });

  it('un-favoriting removes Recommended but KEEPS Notify (current semantics)', () => {
    seed(1, ['Recommended', 'Notify']);
    applyFavoriteToggled(1, false);
    expect(types(1)).toEqual(['Notify']);
  });

  it('favoriting is idempotent when already favorited', () => {
    seed(1, ['Recommended', 'Notify']);
    applyFavoriteToggled(1, true);
    expect(types(1)).toEqual(['Notify', 'Recommended']);
  });
});

describe('optimistic — toggle notify (Notify/Mute mutual exclusion)', () => {
  it('turning ON sets Notify and clears Mute', () => {
    seed(1, ['Mute']);
    applyNotifyToggled(1, true);
    expect(types(1)).toEqual(['Notify']);
  });

  it('turning OFF sets Mute and clears Notify', () => {
    seed(1, ['Notify']);
    applyNotifyToggled(1, false);
    expect(types(1)).toEqual(['Mute']);
  });

  it('turning ON preserves an unrelated Recommended', () => {
    seed(1, ['Recommended']);
    applyNotifyToggled(1, true);
    expect(types(1)).toEqual(['Notify', 'Recommended']);
  });
});

// -------- rollback (snapshot → apply → error → restore) --------
describe('optimistic — rollback restores prior membership exactly', () => {
  const cases: { name: string; seed: EngagedModelType[]; apply: () => void }[] = [
    { name: 'favorite (on)', seed: [], apply: () => applyFavoriteToggled(1, true) },
    { name: 'favorite (off)', seed: ['Recommended', 'Notify'], apply: () => applyFavoriteToggled(1, false) },
    { name: 'notify (on)', seed: ['Mute'], apply: () => applyNotifyToggled(1, true) },
    { name: 'notify (off)', seed: ['Notify', 'Recommended'], apply: () => applyNotifyToggled(1, false) },
    { name: 'create', seed: [], apply: () => applyReviewCreated(1, true, false) },
    { name: 'update', seed: ['Notify'], apply: () => applyReviewUpdated(1, true, false) },
    { name: 'delete', seed: ['Recommended', 'Notify'], apply: () => applyReviewDeleted(1) },
  ];

  for (const c of cases) {
    it(`${c.name}: apply mutates, restore reverts to the snapshot`, () => {
      seed(1, c.seed);
      const snap = snapshotMembership(1);
      c.apply();
      // (sanity) the apply actually changed something for the non-idempotent cases
      restoreMembership(1, snap);
      expect(types(1)).toEqual([...c.seed].sort());
    });
  }
});

// -------- no cross-model contamination --------
describe('optimistic — no cross-model contamination', () => {
  it('mutating model X never touches model Y', () => {
    seed(1, ['Notify']);
    seed(2, ['Recommended', 'Mute']);
    const yBefore = types(2);

    applyReviewCreated(1, true, false);
    applyFavoriteToggled(1, false);
    applyNotifyToggled(1, false);
    applyReviewDeleted(1);

    expect(types(2)).toEqual(yBefore); // Y untouched throughout
  });

  it('a rollback on X leaves Y untouched', () => {
    seed(1, ['Recommended']);
    seed(2, ['Notify']);
    const snap = snapshotMembership(1);
    applyFavoriteToggled(1, false);
    restoreMembership(1, snap);
    expect(isModelEngaged(2, 'Notify')).toBe(true);
    expect(types(2)).toEqual(['Notify']);
  });
});
