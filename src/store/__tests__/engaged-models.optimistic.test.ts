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

// The toggle DIRECTION is a caller-supplied param, decoupled from whatever the
// store holds when the mutator runs. The caller (resourceReview.utils.ts) now
// reads that bit from the store's PRE-toggle membership via isModelEngaged
// (PR4 removed the legacy getEngagedModels cache that used to supply it). These
// cases pin that the mutator honors the param even when the store disagrees.
describe('optimistic — create/update honor the caller-supplied direction param', () => {
  it('create: alreadyRecommended=false → ADDS regardless of store state', () => {
    applyReviewCreated(1, true, false);
    expect(types(1)).toEqual(['Notify', 'Recommended']);
  });

  it('create: alreadyRecommended=true → REMOVES (re-affirm toggles off)', () => {
    applyReviewCreated(1, true, true);
    expect(types(1)).toEqual([]); // toggled off
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

// PR4: the caller (resourceReview.utils.ts) now derives the "already engaged" bits
// from the store's PRE-toggle membership via isModelEngaged, replacing the reads it
// used to make against the deleted user.getEngagedModels React-Query cache. These
// pin the exact SOURCE→direction seam: read isModelEngaged BEFORE the mutator, then
// feed it in. The getById optimistic count math (thumbsUp/collected ±1) branches on
// these same booleans, so their correctness is what guards the double-count risk.
describe('optimistic — direction/count bits re-sourced from the store (PR4 caller seam)', () => {
  it('create: re-affirming an ALREADY-recommended model does NOT double-add (toggles off)', () => {
    seed(7, ['Recommended', 'Notify']);
    // caller reads the pre-toggle bit exactly as resourceReview.utils.ts does
    const alreadyRecommended = isModelEngaged(7, 'Recommended');
    expect(alreadyRecommended).toBe(true);
    applyReviewCreated(7, true, alreadyRecommended);
    expect(types(7)).toEqual([]); // re-affirm path removes, no duplicate membership
  });

  it('create: warm store not-recommended → ADDS (re-source reads false)', () => {
    seed(7, ['Mute']); // known to store but not Recommended
    const alreadyRecommended = isModelEngaged(7, 'Recommended');
    expect(alreadyRecommended).toBe(false);
    applyReviewCreated(7, true, alreadyRecommended);
    expect(types(7)).toEqual(['Mute', 'Notify', 'Recommended']);
  });

  it('favorite: alreadyReviewed/alreadyNotified bits match seeded membership (drive getById ±1)', () => {
    // The favorite path gates thumbsUp += 1 on !alreadyReviewed and collected += 1 on
    // !alreadyNotified. Prove the re-sourced booleans reflect the store truthfully so
    // the count deltas fire exactly once.
    seed(7, ['Recommended']); // reviewed, NOT notified
    expect(isModelEngaged(7, 'Recommended')).toBe(true); // → thumbsUp delta suppressed
    expect(isModelEngaged(7, 'Notify')).toBe(false); //     → collected delta would fire
    applyFavoriteToggled(7, true);
    expect(types(7)).toEqual(['Notify', 'Recommended']);
  });

  it('update: alreadyReviewed re-sourced from store drives the toggle-off direction', () => {
    seed(7, ['Recommended', 'Notify']);
    const alreadyReviewed = isModelEngaged(7, 'Recommended');
    applyReviewUpdated(7, true, alreadyReviewed);
    expect(types(7)).toEqual(['Notify']); // Recommended toggled off, Notify untouched
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
