import { defFamily, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SEED, aspectRatioDef, enumDef, sliderDef } from '../defs';
import { familyScope, modelIdOf, promptOnlyTextBlock, type FamilyExt } from '../shared';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';

/**
 * Seedream (v3 / v4 / v4.5 / v5.0-lite / v5.0-pro), ported from
 * `seedream-graph.ts`. One field set across versions — only the 2K/4K
 * resolution toggle is version-gated. No negative prompt, sampler, steps, or
 * CLIP skip.
 */

// ---- copied from seedream-graph.ts, which dies with the data-graph engine ---

export type SeedreamVersion = 'v3' | 'v4' | 'v4.5' | 'v5.0-lite' | 'v5.0-pro';

export const seedreamVersionIds = {
  v3: 2208174,
  v4: 2208278,
  'v4.5': 2470991,
  'v5.0-lite': 2720141,
  'v5.0-pro': 3110984,
} as const;

const seedreamVersionOptions = [
  { label: 'v3', value: seedreamVersionIds.v3 },
  { label: 'v4', value: seedreamVersionIds.v4 },
  { label: 'v4.5', value: seedreamVersionIds['v4.5'] },
  { label: 'v5.0 lite', value: seedreamVersionIds['v5.0-lite'] },
  { label: 'v5.0 pro', value: seedreamVersionIds['v5.0-pro'] },
];

const seedreamAspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const seedreamResolutionOptions = [
  { label: '2K', value: '2K' },
  { label: '4K', value: '4K' },
] as const;

/** v5.0-pro accepts 4K dimensions but downsamples to 2K, so no toggle there. */
const versionsWithResolutionToggle = new Set<number>([
  seedreamVersionIds['v4.5'],
  seedreamVersionIds['v5.0-lite'],
]);

// ---- end of seedream-graph.ts copies ----------------------------------------

const RESOLUTION = enumDef({ options: seedreamResolutionOptions, default: '4K' });

/** Aspect-ratio option sets vary per resolution tier; memoize per key. */
const AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options: getAspectRatioOptions(resolution as '2K' | '4K', seedreamAspectRatioList),
    default: '1:1',
  })
);

export const seedream = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('images', img2imgImages({ max: 7 }))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: seedreamVersionOptions },
      defaultModelId: seedreamVersionIds['v5.0-pro'],
    })
  )
  .field('resolution', ({ model }) =>
    modelIdOf(model) != null && versionsWithResolutionToggle.has(modelIdOf(model)!)
      ? RESOLUTION
      : null
  )
  // toggle-less versions render at 2K, though the toggle itself defaults to 4K
  .field('aspectRatio', ({ resolution }) => AR(resolution ?? '2K'))
  .field('cfgScale', sliderDef({ min: 1, max: 20, default: 5, step: 0.5 }))
  .field('seed', SEED)
  .use(promptOnlyTextBlock);

export { seedreamVersionOptions };
