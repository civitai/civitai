import type { ComfySampler, ComfyScheduler } from '@civitai/orchestration-client';
import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SDXL_FULL_AR, SEED, selectDef, sliderDef } from '../defs';
import { familyResources, familyScope, makeTextBlock, type FamilyExt } from '../shared';

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

const flux2KleinSamplers = [
  'euler',
  'heun',
  'dpmpp_2s_ancestral',
  'dpmpp_2m',
  'ipndm',
  'ipndm_v',
  'lcm',
] satisfies ComfySampler[];
const flux2KleinSchedules = [
  'simple',
  'normal',
  'karras',
  'exponential',
] satisfies ComfyScheduler[];

const ecosystemToMode: Record<string, Flux2KleinMode> = {
  Flux2Klein_9B: '9b',
  Flux2Klein_9B_base: '9b-base',
  Flux2Klein_4B: '4b',
  Flux2Klein_4B_base: '4b-base',
};

const distilled = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_FULL_AR)
  // scoped per arm: base's 20-50 range shares the family bucket and its
  // values fail distilled's max(12) at validate
  .field('steps', { ...sliderDef({ min: 4, max: 12, default: 8 }), scope: 'distilled' })
  .field('seed', SEED);

const base = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_FULL_AR)
  .field('sampler', selectDef({ options: flux2KleinSamplers, default: 'euler' }))
  .field('scheduler', selectDef({ options: flux2KleinSchedules, default: 'simple' }))
  .field('cfgScale', sliderDef({ min: 2, max: 20, default: 7, step: 0.5 }))
  .field('steps', { ...sliderDef({ min: 20, max: 50, default: 30 }), scope: 'base' })
  .field('seed', SEED);

/** Tagged: the picked key is stamped into state as `flux2KleinMode`. */
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
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));

export { flux2KleinModeVersionOptions, flux2KleinVersionIds };
