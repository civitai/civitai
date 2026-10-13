import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { fluxVersionIds } from '../image/flux.graph';
import {
  deriveSelectorsFromModel,
  deriveWorkflowFromModel,
  effectiveEcosystemOf,
  FLUX_DRAFT_ID,
  FLUX_MODE_IDS,
  reconcileSelectors,
} from '../reconcile';
import type { GenerationCtx } from '~/shared/generation/context';
import { viduVersionIds } from '~/shared/generation/version-ids';

/**
 * The selector-reconciliation policy: one pure function, two adapters. The
 * parity suites prove the parse-boundary adapter against the oracle across
 * the whole matrix; this file pins the policy's edges and proves the STORE
 * adapter fires — an interactive model pick must move the selectors the same
 * way a stored draft does at parse.
 */

const CTX: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const SD15_MODEL = { id: 128713, baseModel: 'SD 1.5' };
const LTXV23_MODEL = { id: 2749948, baseModel: 'LTXV 2.3' };
const FLUX2_KLEIN_4B_MODEL = { id: 2612557, baseModel: 'Flux.2 Klein 4B' };

describe('deriveSelectorsFromModel', () => {
  it('moves the ecosystem when the workflow survives the switch', () => {
    expect(
      deriveSelectorsFromModel(SD15_MODEL, { ecosystem: 'SDXL', workflow: 'txt2img' })
    ).toEqual({ ecosystem: 'SD1' });
  });

  it('is a no-op for a same-ecosystem model, a missing model, and an id-only model', () => {
    expect(
      deriveSelectorsFromModel(SD15_MODEL, { ecosystem: 'SD1', workflow: 'txt2img' })
    ).toBeUndefined();
    expect(
      deriveSelectorsFromModel(undefined, { ecosystem: 'SDXL', workflow: 'txt2img' })
    ).toBeUndefined();
    expect(
      deriveSelectorsFromModel({ id: 99999 }, { ecosystem: 'SDXL', workflow: 'txt2img' })
    ).toBeUndefined();
  });

  it('switches the workflow too when the target ecosystem lacks the current one', () => {
    const fromImage = deriveSelectorsFromModel(LTXV23_MODEL, {
      ecosystem: 'SDXL',
      workflow: 'img2img',
    });
    expect(fromImage?.ecosystem).toBe('LTXV23');
    expect(fromImage?.workflow).toBeDefined();
  });

  it('a locked slot beats a cross-family model (wan, ltx)', () => {
    expect(
      deriveSelectorsFromModel(SD15_MODEL, { ecosystem: 'LTXV2', workflow: 'txt2vid' })
    ).toBeUndefined();
    expect(
      deriveSelectorsFromModel(SD15_MODEL, { ecosystem: 'WanVideo27', workflow: 'txt2vid' })
    ).toBeUndefined();
  });

  it('version siblings re-pick THROUGH the lock', () => {
    expect(
      deriveSelectorsFromModel(LTXV23_MODEL, { ecosystem: 'LTXV2', workflow: 'txt2vid' })
    ).toEqual({ ecosystem: 'LTXV23' });
    // Klein's four variants are four ecosystems, and each one is model-locked,
    // so its version buttons ARE this switch — refuse it and they do nothing.
    expect(
      deriveSelectorsFromModel(FLUX2_KLEIN_4B_MODEL, {
        ecosystem: 'Flux2Klein_9B',
        workflow: 'txt2img',
      })
    ).toEqual({ ecosystem: 'Flux2Klein_4B' });
  });
});

describe('deriveWorkflowFromModel', () => {
  it('a workflow-scoped version drags the workflow (boogu), both directions', () => {
    expect(
      deriveWorkflowFromModel({ id: 3049824 }, { ecosystem: 'Boogu', workflow: 'txt2img' })
    ).toEqual({ workflow: 'img2img:edit' });
    expect(
      deriveWorkflowFromModel({ id: 3049541 }, { ecosystem: 'Boogu', workflow: 'img2img:edit' })
    ).toEqual({ workflow: 'txt2img' });
    // valid for the current workflow, or unknown id: no-op
    expect(
      deriveWorkflowFromModel({ id: 3050010 }, { ecosystem: 'Boogu', workflow: 'txt2img' })
    ).toBeUndefined();
    expect(
      deriveWorkflowFromModel({ id: 99999 }, { ecosystem: 'Boogu', workflow: 'txt2img' })
    ).toBeUndefined();
    // unregistered families never move
    expect(
      deriveWorkflowFromModel({ id: 2983023 }, { ecosystem: 'Krea2', workflow: 'txt2img' })
    ).toBeUndefined();
  });

  it('vidu Q4 moves text-to-video and first/last frame to img2vid, and keeps ref2vid', () => {
    const q4 = { id: viduVersionIds.q4 };
    expect(deriveWorkflowFromModel(q4, { ecosystem: 'Vidu', workflow: 'txt2vid' })).toEqual({
      workflow: 'img2vid',
    });
    expect(
      deriveWorkflowFromModel(q4, { ecosystem: 'Vidu', workflow: 'img2vid:first-last' })
    ).toEqual({ workflow: 'img2vid' });
    expect(deriveWorkflowFromModel(q4, { ecosystem: 'Vidu', workflow: 'img2vid' })).toBeUndefined();
    expect(
      deriveWorkflowFromModel(q4, { ecosystem: 'Vidu', workflow: 'img2vid:ref2vid' })
    ).toBeUndefined();
    // Q1 still does text-to-video
    expect(
      deriveWorkflowFromModel({ id: viduVersionIds.q1 }, { ecosystem: 'Vidu', workflow: 'txt2vid' })
    ).toBeUndefined();
  });
});

describe('flux draft', () => {
  it("reconcile's inlined flux ids match the graph's", () => {
    expect(FLUX_DRAFT_ID).toBe(fluxVersionIds.draft);
    expect([...FLUX_MODE_IDS].sort()).toEqual(Object.values(fluxVersionIds).sort());
  });

  it('the draft build moves a txt2img parse into the draft workflow', () => {
    expect(
      deriveWorkflowFromModel({ id: FLUX_DRAFT_ID }, { ecosystem: 'Flux1', workflow: 'txt2img' })
    ).toEqual({ workflow: 'txt2img:draft' });
    // leaving draft is click-only: at parse the graph forces the draft build instead
    expect(
      reconcileSelectors({ ecosystem: 'Flux1', workflow: 'txt2img:draft', model: 691639 }).note
    ).toBeUndefined();
  });

  it('draft locks the flux picker against a cross-family model', () => {
    expect(
      deriveSelectorsFromModel(SD15_MODEL, { ecosystem: 'Flux1', workflow: 'txt2img:draft' })
    ).toBeUndefined();
  });
});

describe('effectiveEcosystemOf', () => {
  it('accepts the switch only when the workflow survives it', () => {
    expect(effectiveEcosystemOf(SD15_MODEL, 'SDXL', 'txt2img')).toBe('SD1');
    // LTXV23 lacks img2img, so the family computed must keep the selection
    expect(effectiveEcosystemOf(LTXV23_MODEL, 'SDXL', 'img2img')).toBe('SDXL');
  });
});

describe('reconcileSelectors', () => {
  it('rewrites the raw payload and reports the correction', () => {
    const { raw, note } = reconcileSelectors({
      ecosystem: 'SDXL',
      workflow: 'txt2img',
      model: SD15_MODEL,
      prompt: 'a cat',
    });
    expect(raw.ecosystem).toBe('SD1');
    expect(raw.prompt).toBe('a cat');
    expect(note).toEqual({ reason: 'model_wins', ecosystem: 'SD1' });
  });

  it('is idempotent', () => {
    const once = reconcileSelectors({ ecosystem: 'SDXL', model: SD15_MODEL });
    const twice = reconcileSelectors(once.raw);
    expect(twice.raw).toEqual(once.raw);
    expect(twice.note).toBeUndefined();
  });

  it('passes an unreadable model through untouched', () => {
    const input = { ecosystem: 'SDXL', model: 'garbage' };
    expect(reconcileSelectors(input).raw).toBe(input);
  });
});

describe('store rule', () => {
  it('an interactive model pick drags the ecosystem, matching the parse boundary', () => {
    const store = generationHub.createStore({
      ext: CTX,
      defaults: { workflow: 'txt2img', ecosystem: 'SDXL' },
    });
    store.set({ model: SD15_MODEL });
    const state = store.getSnapshot().state as Record<string, unknown>;
    expect(state.ecosystem).toBe('SD1');

    const parsed = generationHub.parse(
      reconcileSelectors({ workflow: 'txt2img', ecosystem: 'SDXL', model: SD15_MODEL, prompt: 'x' })
        .raw,
      CTX
    );
    expect(parsed.success && (parsed.data as Record<string, unknown>).ecosystem).toBe('SD1');
  });

  it('picking the flux Draft build moves txt2img to the draft workflow, and back', () => {
    const store = generationHub.createStore({
      ext: CTX,
      defaults: { workflow: 'txt2img', ecosystem: 'Flux1' },
    });
    const state = () => store.getSnapshot().state as Record<string, unknown>;

    store.set({ model: { id: 699279, baseModel: 'Flux.1 D' } });
    expect(state().workflow).toBe('txt2img:draft');

    store.set({ model: { id: 691639, baseModel: 'Flux.1 D' } });
    expect(state().workflow).toBe('txt2img');
  });

  it('does not fire for a same-ecosystem pick', () => {
    const store = generationHub.createStore({
      ext: CTX,
      defaults: { workflow: 'txt2img', ecosystem: 'SDXL' },
    });
    store.set({ model: { id: 1, baseModel: 'SDXL 1.0' } });
    expect((store.getSnapshot().state as Record<string, unknown>).ecosystem).toBe('SDXL');
  });
});
