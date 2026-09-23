import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, imagesDef, sliderDef, workflowScoped } from '../defs';
import { familyScope, makeTextBlock, type FamilyExt } from '../shared';

/**
 * Wan IMAGE generation (currently v2.7 only), ported from
 * `wan-image-graph.ts`. Separate from the wan video family so image versions
 * pick independently. The aspect-ratio picker hides when edit images are
 * staged (the output follows the source).
 */

// ---- copied from wan-image-graph.ts, which dies with the data-graph engine --

const wanImageVersionDefs = [
  {
    version: 'v2.7',
    label: '2.7',
    ecosystems: { t2i: 'WanImage27' },
  },
] as const;

type WanImageVersion = (typeof wanImageVersionDefs)[number]['version'];

const wanImageVersionOptions = wanImageVersionDefs.map((d) => ({
  label: d.label,
  value: d.version,
}));

const ecosystemToImageVersionDef = new Map<string, (typeof wanImageVersionDefs)[number]>(
  wanImageVersionDefs.flatMap((def) =>
    Object.values(def.ecosystems).map((eco) => [eco, def] as const)
  )
);

export const wan27VersionId = 2828170;

/** Mapped to fal imageSize in the handler. */
const wan27ImageAspectRatios = [
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:3', value: '4:3', width: 1024, height: 768 },
  { label: '3:4', value: '3:4', width: 768, height: 1024 },
  { label: '16:9', value: '16:9', width: 1024, height: 576 },
  { label: '9:16', value: '9:16', width: 576, height: 1024 },
];

// ---- end of wan-image-graph.ts copies ---------------------------------------

const v27 = defineGraph<FamilyExt & { images?: { url: string }[] }>()
  .field('aspectRatio', ({ _ext }) =>
    Array.isArray(_ext.images) && _ext.images.length > 0
      ? null
      : aspectRatioDef({ options: wan27ImageAspectRatios, default: '1:1' })
  )
  .field('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    default: false,
  });

/** Tagged: v1's `wanImageVersion` computed becomes the branch key. */
const versions = branch(
  'wanImageVersion',
  (ext: FamilyExt) => ecosystemToImageVersionDef.get(ext.ecosystem)?.version ?? 'v2.7',
  { 'v2.7': v27 }
);

export const wanImage = defineGraph<FamilyExt>({ scope: familyScope })
  .field(
    'images',
    workflowScoped(({ _ext }) =>
      !_ext.workflow.startsWith('txt') ? imagesDef({ warnOnMissingAiMetadata: true, max: 5 }) : null
    )
  )
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field('seed', SEED)
  .field(
    'cfgScale',
    sliderDef({
      min: 1,
      max: 10,
      step: 0.5,
      default: 3.5,
      presets: [
        { label: 'Low', value: 2 },
        { label: 'Balanced', value: 3.5 },
        { label: 'High', value: 6 },
      ],
    })
  )
  .use(versions)
  // v1 builds the negative editor inside the version branch with a 500-char
  // cap; whether it registers as a snippet target is pinned by the matrix
  .use(makeTextBlock({ negativePromptMaxLength: 500, negativePromptRegistersTarget: false }));

export { wanImageVersionOptions, wan27ImageAspectRatios };

export type { WanImageVersion };
