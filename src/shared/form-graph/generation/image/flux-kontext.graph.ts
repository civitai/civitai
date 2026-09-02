import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SEED, aspectRatioDef, sliderDef } from '../defs';
import { versionModeOf, familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Flux.1 Kontext (pro + max modes), ported from `flux-kontext-graph.ts`.
 * Primarily img2img; no LoRAs, negative prompt, sampler, steps, or CLIP skip.
 * Both modes expose the same fields, so the mode is just a version pick — no
 * branch needed.
 */

// ---- copied from flux-kontext-graph.ts, which dies with the data-graph engine

export type FluxKontextMode = 'pro' | 'max';

const fluxKontextVersionIds = {
  pro: 1892509,
  max: 1892523,
} as const;

const fluxKontextModeVersionOptions = [
  { label: 'Pro', value: fluxKontextVersionIds.pro },
  { label: 'Max', value: fluxKontextVersionIds.max },
];

const fluxKontextAspectRatios = [
  { label: '21:9', value: '21:9', width: 2352, height: 1008 },
  { label: '16:9', value: '16:9', width: 1792, height: 1008 },
  { label: '4:3', value: '4:3', width: 1344, height: 1008 },
  { label: '3:2', value: '3:2', width: 1512, height: 1008 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '2:3', value: '2:3', width: 1008, height: 1512 },
  { label: '3:4', value: '3:4', width: 1008, height: 1344 },
  { label: '9:16', value: '9:16', width: 1008, height: 1792 },
  { label: '9:21', value: '9:21', width: 1008, height: 2352 },
];

// ---- end of flux-kontext-graph.ts copies ------------------------------------

export const fluxKontext = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('images', img2imgImages({}))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: fluxKontextModeVersionOptions },
      defaultModelId: fluxKontextVersionIds.pro,
    })
  )
  .use(promptOnlyTextBlock)
  .field('aspectRatio', aspectRatioDef({ options: fluxKontextAspectRatios, default: '1:1' }))
  .field('cfgScale', sliderDef({ min: 2, max: 20, default: 3.5, step: 0.5 }))
  .field('seed', SEED);

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const fluxKontextModeOf = versionModeOf(fluxKontextVersionIds, 'pro');

export { fluxKontextModeVersionOptions, fluxKontextVersionIds };
