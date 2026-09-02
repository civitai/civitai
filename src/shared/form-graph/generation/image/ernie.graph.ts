import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, resourcesDef } from '../defs';
import { familyScope, modelIdOf, perModelSlider, textBlock, type FamilyExt } from '../shared';

/**
 * Ernie (base + turbo), ported from `ernie-graph.ts`. Turbo drops LoRA support
 * and runs low-guidance/low-step; negative prompt everywhere.
 */

// ---- copied from ernie-graph.ts, which dies with the data-graph engine ------

export const ernieVersionIds = {
  ernie: 2863858,
  turbo: 2863892,
} as const;

type ErnieVariant = 'base' | 'turbo';

const ernieVersionOptions = [
  { label: 'Ernie', value: ernieVersionIds.ernie },
  { label: 'Turbo', value: ernieVersionIds.turbo },
];

/** From HuggingFace recommended settings. */
const ernieAspectRatios = [
  { label: '16:9', value: '16:9', width: 1376, height: 768 },
  { label: '3:2', value: '3:2', width: 1264, height: 848 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '2:3', value: '2:3', width: 848, height: 1264 },
  { label: '9:16', value: '9:16', width: 768, height: 1376 },
];

// ---- end of ernie-graph.ts copies -------------------------------------------

type ErnieModeExt = FamilyExt & { model?: unknown };

const variantOf = (ext: ErnieModeExt): ErnieVariant =>
  modelIdOf(ext.model) === ernieVersionIds.turbo ? 'turbo' : 'base';

const base = defineGraph<ErnieModeExt>()
  .scope(familyScope)
  .field('resources', ({ _ext }) =>
    // v1's ernie uses raw resourcesNode: NO cross-ecosystem filter
    resourcesDef({
      ecosystem: _ext.ecosystem,
      limit: _ext.limits.maxResources,
      filterIncompatible: false,
    })
  )
  .field('cfgScale', perModelSlider({ min: 1, max: 20, default: 4, step: 0.5 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 20 }));

const turbo = defineGraph<ErnieModeExt>()
  .scope(familyScope)
  .field('cfgScale', perModelSlider({ min: 1, max: 20, default: 1, step: 0.5 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 8 }));

/** Tagged: v1's `ernieVariant` computed becomes the branch key. */
const variants = branch('ernieVariant', variantOf, { base, turbo });

export const ernie = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: ernieVersionOptions },
      defaultModelId: ernieVersionIds.ernie,
    })
  )
  .use(variants)
  .field('aspectRatio', aspectRatioDef({ options: ernieAspectRatios, default: '1:1' }))
  .use(textBlock)
  .field('seed', SEED);

export { ernieVersionOptions };
