import { branch, defineGraph } from 'form-graph';
import { checkpointDef, type VersionGroup } from '../checkpoint';
import { SDXL_SQUARE_AR, SEED, selectDef, sliderDef } from '../defs';
import { familyResources, familyScope, makeTextBlock, modelIdOf, type FamilyExt } from '../shared';

/**
 * HiDream (fast / dev / full, at FP8 and FP16 precisions), ported from
 * `hi-dream-graph.ts`. A hierarchical version picker (precision → variant);
 * fast/dev expose only aspect ratio + seed, full adds LoRAs, negative prompt,
 * the UniPC sampler, cfg and steps.
 */

// ---- copied from hi-dream-graph.ts, which dies with the data-graph engine ---

export type HiDreamVariant = 'fast' | 'dev' | 'full';

const hiDreamVersions: VersionGroup = {
  label: 'Precision',
  options: [
    {
      label: 'FP8',
      value: 1771369, // default: fp8 dev
      children: {
        label: 'Variant',
        options: [
          { label: 'Fast', value: 1770945 },
          { label: 'Dev', value: 1771369 },
          { label: 'Full', value: 1772448 },
        ],
      },
    },
    {
      label: 'FP16',
      value: 1769068, // default: fp16 dev
      children: {
        label: 'Variant',
        options: [
          { label: 'Fast', value: 1768731 },
          { label: 'Dev', value: 1769068 },
        ],
      },
    },
  ],
};

const versionIdToVariant = new Map<number, HiDreamVariant>(
  hiDreamVersions.options.flatMap((precision) =>
    (precision.children?.options ?? []).map(
      (opt) => [opt.value, opt.label.toLowerCase() as HiDreamVariant] as const
    )
  )
);

// ---- end of hi-dream-graph.ts copies ----------------------------------------

type HiDreamModeExt = FamilyExt & { model?: unknown };

const variantOf = (ext: HiDreamModeExt): HiDreamVariant => {
  const id = modelIdOf(ext.model);
  return (id != null ? versionIdToVariant.get(id) : undefined) ?? 'dev';
};

const fastDev = defineGraph<HiDreamModeExt>()
  .scope(familyScope)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('seed', SEED);

const full = defineGraph<HiDreamModeExt>()
  .scope(familyScope)
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('sampler', selectDef({ options: ['UniPC'], default: 'UniPC' }))
  .field('cfgScale', sliderDef({ min: 1, max: 20, default: 5, step: 0.5 }))
  .field('steps', sliderDef({ min: 20, max: 100, default: 50 }))
  .field('seed', SEED);

/** Tagged: v1's `hiDreamVariant` computed becomes the branch key. */
const variants = branch('hiDreamVariant', variantOf, { fast: fastDev, dev: fastDev, full });

export const hiDream = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: hiDreamVersions,
      defaultModelId: 1771369, // fp8 dev
    })
  )
  .use(variants)
  // negativePrompt lives only in v1's full subgraph, where its snippet
  // registration never fires
  .use(
    makeTextBlock({
      negativePrompt: (ext) => variantOf(ext as HiDreamModeExt) === 'full',
      negativePromptRegistersTarget: false,
    })
  );
