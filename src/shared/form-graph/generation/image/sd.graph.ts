import { defineGraph, rootScope } from 'form-graph';
import {
  DRAFT_WORKFLOW,
  getSdDraftMode,
  sd1AspectRatioBuckets,
  sd1CustomDimensionLimits,
  samplers,
} from '~/shared/constants/generation.constants';
import {
  sd1ControlNetPreprocessors,
  sdxlControlNetPreprocessors,
} from '~/shared/constants/controlnets.constants';
import { checkpointDef } from '../checkpoint';
import { effectiveEcosystemOf } from '../reconcile';
import {
  SEED,
  defaultSamplerPresets,
  SDXL_FULL_AR,
  aspectRatioDef,
  controlNetsDef,
  imagesDef,
  workflowScoped,
  resourcesDef,
  selectDef,
  sliderDef,
  vaeDef,
  type AspectRatioValue,
  type ImageEntry,
} from '../defs';
import { familyScope, textBlock, type FamilyExt, narrowEcosystem } from '../shared';

/**
 * Stable Diffusion family (SD1 / SDXL / Pony / Illustrious / NoobAI).
 */

const MAX_UPSCALE_RESOLUTION = 4096;

const DENOISE_ALWAYS = [
  'img2img',
  'txt2img:face-fix',
  'img2img:face-fix',
  'txt2img:hires-fix',
  'img2img:hires-fix',
];

const SAMPLER = selectDef({ options: samplers, presets: defaultSamplerPresets });
const CFG = sliderDef({
  min: 1,
  max: 10,
  step: 0.5,
  default: 7,
  presets: [
    { label: 'Creative', value: 4 },
    { label: 'Balanced', value: 7 },
    { label: 'Precise', value: 10 },
  ],
});
const STEPS = sliderDef({
  min: 10,
  max: 50,
  default: 30,
  presets: [
    { label: 'Fast', value: 20 },
    { label: 'Balanced', value: 30 },
    { label: 'High', value: 40 },
  ],
});
const CLIP_SKIP = sliderDef({ min: 1, max: 3, default: 2 });

// Draft's narrow ranges would clamp the stored values one-way, so draft keeps its own, per
// ecosystem since SD1's and SDXL's ranges differ too.
const draftScope = (ecosystem: string) => rootScope(DRAFT_WORKFLOW, ecosystem);

const hasImages = (images: ImageEntry[] | undefined) => Array.isArray(images) && images.length > 0;

const upscaleDims = (
  workflow: string,
  images: ImageEntry[] | undefined,
  aspectRatio: AspectRatioValue | undefined
) => {
  if (!workflow.includes('hires')) return undefined;
  const w = images?.[0]?.width ?? aspectRatio?.width;
  const h = images?.[0]?.height ?? aspectRatio?.height;
  if (!w || !h) return undefined;
  const scale =
    Math.max(w, h) * 1.5 <= MAX_UPSCALE_RESOLUTION ? 1.5 : MAX_UPSCALE_RESOLUTION / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
};

export const sd = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelWins: true,
    })
  )
  // An unlocked model from another ecosystem drags the ecosystem with it (when the
  // workflow allows). The selection stays in the
  // hub field (shadowed off the wire); this derived value carries the wire
  // name, and everything ecosystem-dependent below reads IT.
  .computed(
    'effectiveEcosystem',
    ({ model, _ext }) =>
      narrowEcosystem(
        ['SD1', 'SDXL', 'Pony', 'Illustrious', 'NoobAI'],
        effectiveEcosystemOf(model, _ext.ecosystem, _ext.workflow)
      ),
    { emit: 'ecosystem' }
  )
  .field(
    'images',
    workflowScoped(({ _ext }) => (_ext.workflow.startsWith('img2img') ? imagesDef({}) : null))
  )
  .field('resources', ({ effectiveEcosystem, _ext }) =>
    resourcesDef({ ecosystem: effectiveEcosystem, limit: _ext.limits.maxResources })
  )
  .field('vae', ({ effectiveEcosystem }) => vaeDef({ ecosystem: effectiveEcosystem }))
  .field('aspectRatio', ({ images, effectiveEcosystem }) =>
    hasImages(images)
      ? null
      : effectiveEcosystem === 'SD1'
      ? aspectRatioDef({ options: sd1AspectRatioBuckets, custom: sd1CustomDimensionLimits })
      : SDXL_FULL_AR
  )
  .use(textBlock)
  .field('sampler', ({ effectiveEcosystem, _ext }) => {
    if (_ext.workflow !== DRAFT_WORKFLOW) return SAMPLER;
    const { sampler } = getSdDraftMode(effectiveEcosystem);
    return {
      ...selectDef({ options: [sampler], default: sampler }),
      scope: draftScope(effectiveEcosystem),
    };
  })
  .field('cfgScale', ({ effectiveEcosystem, _ext }) => {
    if (_ext.workflow !== DRAFT_WORKFLOW) return CFG;
    const { cfgScale } = getSdDraftMode(effectiveEcosystem);
    return { ...sliderDef({ ...cfgScale, step: 0.5 }), scope: draftScope(effectiveEcosystem) };
  })
  .field('steps', ({ effectiveEcosystem, _ext }) => {
    if (_ext.workflow !== DRAFT_WORKFLOW) return STEPS;
    const { steps } = getSdDraftMode(effectiveEcosystem);
    return { ...sliderDef(steps), scope: draftScope(effectiveEcosystem) };
  })
  .field('clipSkip', CLIP_SKIP)
  .field('controlNets', ({ effectiveEcosystem, _ext }) =>
    _ext.workflow === 'txt2img'
      ? controlNetsDef({
          preprocessors:
            effectiveEcosystem === 'SD1' ? sd1ControlNetPreprocessors : sdxlControlNetPreprocessors,
          limit: 1,
        })
      : null
  )
  .field('seed', SEED)
  .field('denoise', ({ images, _ext }) => {
    const alwaysShow = DENOISE_ALWAYS.includes(_ext.workflow);
    const showForTxt2imgImages = _ext.workflow === 'txt2img' && hasImages(images);
    if (!(alwaysShow || showForTxt2imgImages)) return null;
    const isImg2Img = _ext.workflow === 'img2img';
    const max = alwaysShow || isImg2Img || hasImages(images) ? 1 : 0.75;
    return sliderDef({ min: 0, max, step: 0.01, default: 0.75 });
  })
  .computed(
    'upscaleWidth',
    ({ images, aspectRatio, _ext }) => upscaleDims(_ext.workflow, images, aspectRatio)?.width
  )
  .computed(
    'upscaleHeight',
    ({ images, aspectRatio, _ext }) => upscaleDims(_ext.workflow, images, aspectRatio)?.height
  );
