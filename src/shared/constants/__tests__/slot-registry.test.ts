import { describe, expect, it } from 'vitest';
import {
  ALL_SLOT_IDS,
  isKnownSlotId,
  isLaunchSlot,
  isPageSlot,
  KNOWN_SLOT_IDS,
  LAUNCH_SLOT_IDS,
  MODEL_SLOT_IDS,
  PAGE_FORBIDDEN_SCOPES,
  PAGE_SLOT_ID,
  SLOT_REGISTRY,
} from '../slot-registry';

describe('slot-registry (Phase 0 foundation)', () => {
  // BEHAVIOR-PRESERVING GATE (PR1): KNOWN_SLOT_IDS.options MUST deep-equal the
  // historical model-slot tuple, in this exact order. blocks.router.ts uses
  // this enum for listForModel/installOnModel/getEffectiveCheckpoint inputs; a
  // drift here silently changes the model install/mint/resolve contract.
  it('KNOWN_SLOT_IDS.options is byte-identical to the historical 3-model-slot tuple', () => {
    expect(KNOWN_SLOT_IDS.options).toEqual([
      'model.sidebar_top',
      'model.below_images',
      'model.actions_extra',
    ]);
  });

  it('MODEL_SLOT_IDS matches the enum options exactly', () => {
    expect([...MODEL_SLOT_IDS]).toEqual(KNOWN_SLOT_IDS.options);
  });

  it('the page slot is NOT in the model enum (page tokens never use the model slotContext)', () => {
    expect(KNOWN_SLOT_IDS.options).not.toContain(PAGE_SLOT_ID);
    expect((KNOWN_SLOT_IDS.options as readonly string[]).includes('app.page')).toBe(false);
  });

  it('every model slot is entity=model, kind=region, install=model_subscription', () => {
    for (const id of MODEL_SLOT_IDS) {
      const def = SLOT_REGISTRY[id];
      expect(def.entity).toBe('model');
      expect(def.kind).toBe('region');
      expect(def.installModel).toBe('model_subscription');
    }
  });

  it('the page slot is entity=none, kind=page, install=none (stateless)', () => {
    const page = SLOT_REGISTRY[PAGE_SLOT_ID];
    expect(page.entity).toBe('none');
    expect(page.kind).toBe('page');
    expect(page.installModel).toBe('none');
    expect(page.geometry).toBe('viewport');
  });

  it('isPageSlot / isKnownSlotId classify correctly', () => {
    expect(isPageSlot('app.page')).toBe(true);
    expect(isPageSlot('model.sidebar_top')).toBe(false);
    expect(isPageSlot('not.a.slot')).toBe(false);
    expect(isKnownSlotId('app.page')).toBe(true);
    expect(isKnownSlotId('model.sidebar_top')).toBe(true);
    expect(isKnownSlotId('nope')).toBe(false);
  });

  it('ALL_SLOT_IDS is the model slots plus the page slot', () => {
    expect(new Set(ALL_SLOT_IDS)).toEqual(
      new Set([...MODEL_SLOT_IDS, PAGE_SLOT_ID])
    );
  });

  // W10 generation spend: `ai:write:budgeted` is NO LONGER page-forbidden —
  // pages can spend Buzz on generation, bounded by the manifest per-gen budget
  // (page.buzzBudgetPerGen) + the per-user daily cap. Tipping + balance-read
  // stay forbidden (see the doc comment on PAGE_FORBIDDEN_SCOPES for why).
  it('PAGE_FORBIDDEN_SCOPES forbids only tipping + balance-read (NOT budgeted gen)', () => {
    expect([...PAGE_FORBIDDEN_SCOPES].sort()).toEqual(['buzz:read:self', 'social:tip:self'].sort());
  });

  it('ai:write:budgeted is NOT forbidden for pages (generation spend allowed)', () => {
    expect((PAGE_FORBIDDEN_SCOPES as readonly string[]).includes('ai:write:budgeted')).toBe(false);
  });

  // Only `none` and `model` entities are wired in this build. user/image are
  // reserved (Phase 1/2) and must NOT appear yet, so a future PR3 can't be
  // accidentally half-shipped.
  it('only model + none entities are present in the registry today', () => {
    const entities = new Set(Object.values(SLOT_REGISTRY).map((s) => s.entity));
    expect(entities).toEqual(new Set(['model', 'none']));
  });

  // ---------------------------------------------------------------------------
  // PAGE-ONLY LAUNCH GATE — the public-audience launch allowlist.
  // ---------------------------------------------------------------------------
  describe('LAUNCH_SLOT_IDS / isLaunchSlot (page-only launch allowlist)', () => {
    it('the launch allowlist is exactly the page slot today', () => {
      expect([...LAUNCH_SLOT_IDS]).toEqual(['app.page']);
      // The page slot id constant IS the launch slot — they can't drift.
      expect([...LAUNCH_SLOT_IDS]).toContain(PAGE_SLOT_ID);
    });

    it('isLaunchSlot is TRUE for the page slot', () => {
      expect(isLaunchSlot('app.page')).toBe(true);
      expect(isLaunchSlot(PAGE_SLOT_ID)).toBe(true);
    });

    it('isLaunchSlot is FALSE for every model slot (model slots are mod-only at launch)', () => {
      for (const id of MODEL_SLOT_IDS) {
        expect(isLaunchSlot(id), `model slot "${id}" must NOT be a launch slot`).toBe(false);
      }
      expect(isLaunchSlot('model.sidebar_top')).toBe(false);
      expect(isLaunchSlot('model.below_images')).toBe(false);
      expect(isLaunchSlot('model.actions_extra')).toBe(false);
    });

    it('isLaunchSlot is FALSE for an unknown / arbitrary slot id', () => {
      expect(isLaunchSlot('not.a.slot')).toBe(false);
      expect(isLaunchSlot('')).toBe(false);
    });

    // The launch surface must be a SUBSET of the page slots — a model slot must
    // never sneak in (that would expose model apps to the public). This locks
    // the invariant a future widen has to consciously break.
    it('every launch slot is a page slot (no model slot in the launch surface)', () => {
      for (const id of LAUNCH_SLOT_IDS) {
        expect(isPageSlot(id), `launch slot "${id}" must be a page slot`).toBe(true);
      }
    });
  });
});
