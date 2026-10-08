import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import {
  img2imgImages,
  SDXL_FULL_AR_4MP,
  SEED,
  guidancePresetsLowBalHigh,
  sliderDef,
  type ResourceData,
} from '../defs';
import {
  versionModeOf,
  familyResources,
  familyScope,
  promptOnlyTextBlock,
  type FamilyExt,
} from '../shared';

/**
 * Flux.2 (dev / flex / pro / max). No negative
 * prompt, no sampler, no CLIP skip. Only dev supports LoRA resources; the mode
 * derives from the model version id.
 */

export type Flux2Mode = 'dev' | 'flex' | 'pro' | 'max';

const flux2VersionIds = {
  dev: 2439067,
  flex: 2439047,
  pro: 2439442,
  max: 2547175,
} as const;

const flux2ModeVersionOptions = [
  { label: 'Dev', value: flux2VersionIds.dev },
  { label: 'Flex', value: flux2VersionIds.flex },
  { label: 'Pro', value: flux2VersionIds.pro },
  { label: 'Max', value: flux2VersionIds.max },
];

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const flux2ModeOf = versionModeOf(flux2VersionIds, 'dev');

type Flux2ModeExt = FamilyExt & { model?: ResourceData | number };

const CFG = sliderDef({
  min: 2,
  max: 20,
  default: 3.5,
  step: 0.5,
  presets: guidancePresetsLowBalHigh,
});
const STEPS = sliderDef({ min: 20, max: 50, default: 25 });

const noResources = defineGraph<Flux2ModeExt>()
  .field('aspectRatio', SDXL_FULL_AR_4MP)
  .field('cfgScale', CFG)
  .field('steps', STEPS)
  .field('seed', SEED);

const dev = defineGraph<Flux2ModeExt>()
  .field('aspectRatio', SDXL_FULL_AR_4MP)
  .field('cfgScale', CFG)
  .field('steps', STEPS)
  .field('seed', SEED)
  .field('resources', familyResources);

/** Tagged: the picked key is stamped into state as `flux2Mode`. */
const modes = branch('flux2Mode', (ext: Flux2ModeExt) => flux2ModeOf(ext.model), {
  dev,
  flex: noResources,
  pro: noResources,
  max: noResources,
});

export const flux2 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 7 }))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: flux2ModeVersionOptions },
      defaultModelId: flux2VersionIds.dev,
    })
  )
  .use(modes)
  .use(promptOnlyTextBlock);

export { flux2ModeVersionOptions, flux2VersionIds };
