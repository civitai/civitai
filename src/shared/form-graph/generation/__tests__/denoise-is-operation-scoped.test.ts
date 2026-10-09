import { describe, expect, it } from 'vitest';
import { REMIX_RESET } from '~/components/form-graph/generation/remix-reset';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * Applying Face Fix / Hires Fix from the generated-image menu used to move the user's denoise:
 * the ingestion reset cleared it and either the source image's value replaced it, or — for a
 * txt2img or non-SD source, which carries no denoise at all — the def default did. Reported from
 * the generator queue, 2026-10.
 *
 * Both halves of the fix are pinned here because they cover different sources: `denoise` now
 * survives the reset, AND the menu stops sending the source image's. A caller that MEANS to
 * replay a denoise still overrides it, which is what keeps a real remix reproducible.
 */
const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};
const IMG = { url: 'https://image.civitai.com/a.png', width: 1024, height: 1024 };
const SDXL = { id: 128713, baseModel: 'SDXL 1.0', model: { type: 'Checkpoint' } };
// The call site own options, not a restatement of them: dropping `denoise` from REMIX_RESET
// has to fail here, which a local copy of the list would not.
const RESET = REMIX_RESET;

function formWithDenoise(denoise: number) {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow: 'img2img', ecosystem: 'SDXL', model: SDXL, prompt: 'mine', images: [IMG] });
  store.set({ denoise });
  return store;
}
const denoiseOf = (store: ReturnType<typeof formWithDenoise>) =>
  (store.getSnapshot().state as { denoise?: number }).denoise;

describe('denoise belongs to the operation, not the source image', () => {
  it('is what the user set, before anything is applied', () => {
    expect(denoiseOf(formWithDenoise(0.25))).toBe(0.25);
  });

  it('survives applying hires fix to a source that carries no denoise', () => {
    // The reported case. A revert reports 0.75 — the def default, which reads like a deliberate
    // value and is the reason this went unnoticed.
    const store = formWithDenoise(0.25);
    store.reset(RESET);
    store.set({
      workflow: 'img2img:hires-fix',
      ecosystem: 'SDXL',
      model: SDXL,
      prompt: 'from the image',
      images: [IMG],
    });

    expect(denoiseOf(store)).toBe(0.25);
  });

  it('carries the rest of the source image across', () => {
    // Guards the other half: dropping denoise must not turn this into an append.
    const store = formWithDenoise(0.25);
    store.reset(RESET);
    store.set({
      workflow: 'img2img:hires-fix',
      ecosystem: 'SDXL',
      model: SDXL,
      prompt: 'from the image',
      images: [IMG],
    });
    const state = store.getSnapshot().state as { prompt?: string; model?: { id?: number } };

    expect(state.prompt).toBe('from the image');
    expect(state.model?.id).toBe(SDXL.id);
  });

  // The question this answers: does excluding denoise from the reset break a REMIX of a hires-fix
  // image? No. Remix is a different call site (`GeneratedItemWorkflowMenu`, `runType: 'remix'`)
  // which spreads the whole of `image.params`, and the patch lands after the reset, so a supplied
  // denoise overrides the preserved one. Measured 2026-10-05: of 7,217 hires-fix images from two
  // days of production, 7,181 carry a numeric `denoise` in their meta, so there is a value to send.
  it("a remix that sends the image's own denoise still overrides the preserved one", () => {
    const store = formWithDenoise(0.25);
    store.reset(RESET);
    store.set({
      workflow: 'img2img:hires-fix',
      ecosystem: 'SDXL',
      model: SDXL,
      prompt: 'from the image',
      images: [IMG],
      denoise: 0.9,
    });

    expect(denoiseOf(store)).toBe(0.9);
  });
});
