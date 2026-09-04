import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SDXL_SQUARE_AR, SEED, selectDef, sliderDef } from '../defs';
import { familyResources, familyScope, makeTextBlock, type FamilyExt } from '../shared';

/**
 * Flux.2 Klein (9B / 9B Base / 4B / 4B Base), ported from
 * `flux2-klein-graph.ts`. Four ECOSYSTEMS share this graph; the mode derives
 * from the ecosystem, not the model. Distilled variants (9B/4B) hide
 * cfg/sampler/scheduler; Base variants expose the full sd.cpp controls.
 * Negative prompt is supported everywhere.
 */

// ---- copied from flux2-klein-graph.ts, which dies with the data-graph engine

export type Flux2KleinMode = '9b' | '9b-base' | '4b' | '4b-base';

const flux2KleinVersionIds = {
  '9b': 2612554,
  '9b-base': 2612548,
  '4b': 2612557,
  '4b-base': 2612552,
} as const;

const flux2KleinModeVersionOptions = [
  { label: '9B', value: flux2KleinVersionIds['9b'] },
  { label: '9B Base', value: flux2KleinVersionIds['9b-base'] },
  { label: '4B', value: flux2KleinVersionIds['4b'] },
  { label: '4B Base', value: flux2KleinVersionIds['4b-base'] },
];

/** sd.cpp sampler/scheduler options. */
const flux2KleinSamplers = [
  'euler',
  'heun',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
  'ipndm',
  'ipndm_v',
  'lcm',
];
const flux2KleinSchedules = ['simple', 'discrete', 'karras', 'exponential'];

// ---- end of flux2-klein-graph.ts copies -------------------------------------

const ecosystemToMode: Record<string, Flux2KleinMode> = {
  Flux2Klein_9B: '9b',
  Flux2Klein_9B_base: '9b-base',
  Flux2Klein_4B: '4b',
  Flux2Klein_4B_base: '4b-base',
};

const distilled = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('steps', sliderDef({ min: 4, max: 12, default: 8 }))
  .field('seed', SEED);

const base = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('sampler', selectDef({ options: flux2KleinSamplers, default: 'euler' }))
  .field('scheduler', selectDef({ options: flux2KleinSchedules, default: 'simple' }))
  .field('cfgScale', sliderDef({ min: 2, max: 20, default: 7, step: 0.5 }))
  .field('steps', sliderDef({ min: 20, max: 50, default: 30 }))
  .field('seed', SEED);

/** Tagged: v1's `flux2KleinMode` computed becomes the branch key. */
const modes = branch('flux2KleinMode', (ext: FamilyExt) => ecosystemToMode[ext.ecosystem] ?? '9b', {
  '9b': distilled,
  '4b': distilled,
  '9b-base': base,
  '4b-base': base,
});

export const flux2Klein = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 7 }))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: flux2KleinModeVersionOptions },
    })
  )
  .use(modes)
  // v1 merges negativePrompt inside the mode subgraph, where its snippet
  // registration never fires — the oracle's targets carry `prompt` alone
  // (v1's own comment claims otherwise; the differential says no).
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));

export { flux2KleinModeVersionOptions, flux2KleinVersionIds };
