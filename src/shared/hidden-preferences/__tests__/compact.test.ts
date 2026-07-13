import { describe, expect, it } from 'vitest';
import type { HiddenPreferenceTypes } from '~/server/services/user-preferences.service';
import {
  applyOptimisticHiddenToggle,
  applyServerHiddenToggle,
  expandHiddenPreferences,
  HIDDEN_PREFS_COMPACT_VERSION,
  isCompactHiddenPreferences,
  toCompactHiddenPreferences,
} from '~/shared/hidden-preferences/compact';

/**
 * The compact wire shape is a serialize-cost optimization for
 * `hiddenPreferences.getHidden`: it strips the pure-overhead `{ id, hidden: true }`
 * object wrapping on the id-only sets so superjson doesn't freeze the event loop.
 * These tests pin the invariant that MATTERS: expand(compact(legacy)) must be
 * byte-identical to the legacy response — the client-visible data cannot change.
 */

const legacy: HiddenPreferenceTypes = {
  hiddenTags: [
    { id: 1, name: 'nsfw', hidden: true },
    { id: 2, name: 'gore', nsfwLevel: 8 }, // moderated tag (no `hidden`)
  ],
  hiddenUsers: [
    { id: 10, username: 'alice', hidden: true },
    { id: 11, username: null, hidden: true },
  ],
  hiddenModels: [
    { id: 100, hidden: true },
    { id: 101, hidden: true },
  ],
  hiddenModel3Ds: [{ id: 200, hidden: true }],
  hiddenImages: [
    { id: 300, hidden: true }, // explicit hide
    { id: 301, hidden: true }, // explicit hide
    { id: 302, tagId: 2 }, // implicit (tag-vote) hide
  ],
  blockedUsers: [{ id: 20, username: 'bob', hidden: true }],
  blockedByUsers: [{ id: 21, username: 'carol', hidden: true }],
};

describe('hidden-preferences compact shape', () => {
  it('compact shape carries id-only arrays for the model/model3d/explicit-image sets', () => {
    const compact = toCompactHiddenPreferences(legacy);
    expect(compact.__v).toBe(HIDDEN_PREFS_COMPACT_VERSION);
    expect(compact.hiddenModels).toEqual([100, 101]);
    expect(compact.hiddenModel3Ds).toEqual([200]);
    // explicit hides become bare ids; implicit (tagId-bearing) hides stay objects
    expect(compact.hiddenImages).toEqual([300, 301]);
    expect(compact.hiddenImagesImplicit).toEqual([{ id: 302, tagId: 2 }]);
    // object-carrying sets are passed through verbatim (username/name/nsfwLevel intact)
    expect(compact.hiddenTags).toEqual(legacy.hiddenTags);
    expect(compact.hiddenUsers).toEqual(legacy.hiddenUsers);
    expect(compact.blockedUsers).toEqual(legacy.blockedUsers);
    expect(compact.blockedByUsers).toEqual(legacy.blockedByUsers);
  });

  it('expand(compact(legacy)) round-trips to the exact legacy shape', () => {
    const roundTripped = expandHiddenPreferences(toCompactHiddenPreferences(legacy));
    expect(roundTripped).toEqual(legacy);
  });

  it('preserves explicit-then-implicit image ordering on expand', () => {
    const roundTripped = expandHiddenPreferences(toCompactHiddenPreferences(legacy));
    expect(roundTripped.hiddenImages).toEqual([
      { id: 300, hidden: true },
      { id: 301, hidden: true },
      { id: 302, tagId: 2 },
    ]);
  });

  it('expand passes a LEGACY response through unchanged (rolling-deploy safety)', () => {
    expect(expandHiddenPreferences(legacy)).toEqual(legacy);
  });

  it('expand coalesces undefined / missing fields to empty arrays', () => {
    const expanded = expandHiddenPreferences(undefined);
    expect(expanded).toEqual({
      hiddenTags: [],
      hiddenUsers: [],
      hiddenModels: [],
      hiddenModel3Ds: [],
      hiddenImages: [],
      blockedUsers: [],
      blockedByUsers: [],
    });
    // a legacy response missing a newer field (e.g. hiddenModel3Ds) must not crash
    const partial = { hiddenModels: [{ id: 1, hidden: true }] } as unknown as HiddenPreferenceTypes;
    expect(expandHiddenPreferences(partial).hiddenModel3Ds).toEqual([]);
  });

  it('isCompactHiddenPreferences discriminates the two shapes (incl. empty arrays)', () => {
    expect(isCompactHiddenPreferences(toCompactHiddenPreferences(legacy))).toBe(true);
    expect(isCompactHiddenPreferences(legacy)).toBe(false);
    expect(isCompactHiddenPreferences(undefined)).toBe(false);
    // empty arrays are shape-ambiguous WITHOUT the __v discriminator — the whole
    // reason it exists (so the optimistic-update path knows the target shape)
    const emptyCompact = toCompactHiddenPreferences({
      hiddenTags: [],
      hiddenUsers: [],
      hiddenModels: [],
      hiddenModel3Ds: [],
      hiddenImages: [],
      blockedUsers: [],
      blockedByUsers: [],
    });
    expect(isCompactHiddenPreferences(emptyCompact)).toBe(true);
    expect(emptyCompact.hiddenModels).toEqual([]);
  });
});

describe('optimistic cache mutation — shape parity (compact vs legacy)', () => {
  // The load-bearing invariant: an optimistic toggle applied to the COMPACT cache
  // must, after expand, equal the same toggle applied to the LEGACY cache. If it
  // ever diverges, the flag flip silently changes what the user sees hidden.
  // Every consumer of `hiddenImages`/etc. is membership-based (a Map keyed by id,
  // or `.some(x => x.id === …)`), so array ORDER is irrelevant — only the SET of
  // elements matters. (A compact explicit-image add lands before the implicit
  // images; the legacy merged array appends at the end. Same set, different
  // order.) Compare each set order-independently.
  const asSets = (data: any) =>
    Object.fromEntries(
      Object.entries(data).map(([k, v]) => [
        k,
        new Set((v as any[]).map((el) => JSON.stringify(el))),
      ])
    );
  const bothShapesAgree = (
    _key: string,
    apply: (cache: any) => any
    // apply() to legacy directly, apply() to compact then expand → same membership
  ) => {
    const legacyResult = expandHiddenPreferences(apply(structuredClone(legacy)));
    const compactResult = expandHiddenPreferences(apply(toCompactHiddenPreferences(legacy)));
    expect(asSets(compactResult)).toEqual(asSets(legacyResult));
    return compactResult;
  };

  it('optimistic ADD of a model matches across shapes', () => {
    const res = bothShapesAgree('hiddenModels', (cache) =>
      applyOptimisticHiddenToggle(cache, 'hiddenModels', [{ id: 999 }], true)
    );
    expect(res.hiddenModels.map((x) => x.id)).toContain(999);
  });

  it('optimistic REMOVE of a model matches across shapes', () => {
    const res = bothShapesAgree('hiddenModels', (cache) =>
      applyOptimisticHiddenToggle(cache, 'hiddenModels', [{ id: 100 }], false)
    );
    expect(res.hiddenModels.map((x) => x.id)).not.toContain(100);
  });

  it('optimistic TOGGLE (hidden=undefined) of an explicit image matches across shapes', () => {
    // 300 present → toggled off; 400 absent → toggled on
    const res = bothShapesAgree('hiddenImages', (cache) =>
      applyOptimisticHiddenToggle(cache, 'hiddenImages', [{ id: 300 }, { id: 400 }], undefined)
    );
    const ids = res.hiddenImages.map((x) => x.id);
    expect(ids).not.toContain(300);
    expect(ids).toContain(400);
    // implicit tag-vote image untouched
    expect(res.hiddenImages).toContainEqual({ id: 302, tagId: 2 });
  });

  it('optimistic toggle of an OBJECT set (hiddenUsers) preserves username across shapes', () => {
    const res = bothShapesAgree('hiddenUsers', (cache) =>
      applyOptimisticHiddenToggle(
        cache,
        'hiddenUsers',
        [{ id: 30, username: 'dave' }],
        true
      )
    );
    expect(res.hiddenUsers).toContainEqual({ id: 30, username: 'dave', hidden: true });
  });

  it('server-diff reconcile (added/removed) matches across shapes', () => {
    const res = bothShapesAgree('hiddenModels', (cache) =>
      applyServerHiddenToggle(
        cache,
        'hiddenModels',
        [{ kind: 'model', id: 500, hidden: true }],
        [{ kind: 'model', id: 100, hidden: true }]
      )
    );
    const ids = res.hiddenModels.map((x) => x.id);
    expect(ids).toContain(500);
    expect(ids).not.toContain(100);
  });
});
