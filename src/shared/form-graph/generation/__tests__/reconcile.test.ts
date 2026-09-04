import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import {
  deriveSelectorsFromModel,
  deriveWorkflowFromModel,
  effectiveEcosystemOf,
  reconcileSelectors,
} from '../reconcile';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

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

  it('a locked slot beats a cross-family model (flux draft, wan, ltx)', () => {
    expect(
      deriveSelectorsFromModel(SD15_MODEL, { ecosystem: 'Flux1', workflow: 'txt2img:draft' })
    ).toBeUndefined();
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

  it('does not fire for a same-ecosystem pick', () => {
    const store = generationHub.createStore({
      ext: CTX,
      defaults: { workflow: 'txt2img', ecosystem: 'SDXL' },
    });
    store.set({ model: { id: 1, baseModel: 'SDXL 1.0' } });
    expect((store.getSnapshot().state as Record<string, unknown>).ecosystem).toBe('SDXL');
  });
});
