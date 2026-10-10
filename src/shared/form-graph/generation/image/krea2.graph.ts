import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { fourMegapixelCustomDimensionLimits } from '~/shared/constants/generation.constants';
import { fitCustomDimensions } from '~/utils/aspect-ratio-helpers';
import { SEED, aspectRatioDef, enumDef, imagesDef, workflowScoped } from '../defs';
import {
  familyResources,
  familyScope,
  makeTextBlock,
  modelIdOf,
  perModelSlider,
  type FamilyExt,
} from '../shared';

/**
 * Krea 2. One locked checkpoint whose version
 * selector splits across two engines: medium/large are FAL size tiers
 * (creativity + style references, no LoRA), raw/turbo are comfy builds (LoRA,
 * negative prompt, cfg/steps). `img2img:edit` overrides the version into the
 * comfy edit variants and swaps the picker down to the two comfy builds.
 */

export const krea2VersionIds = {
  medium: 2983023,
  large: 2983022,
  raw: 3072329,
  turbo: 3072332,
} as const;

export type Krea2Size = 'medium' | 'large';

type Krea2Variant = 'fal' | 'raw' | 'turbo' | 'editRaw' | 'editTurbo';

const krea2VersionOptions = [
  { label: 'Medium', value: krea2VersionIds.medium },
  { label: 'Large', value: krea2VersionIds.large },
  { label: 'Raw', value: krea2VersionIds.raw },
  { label: 'Turbo', value: krea2VersionIds.turbo },
];

const krea2EditVersionOptions = [
  { label: 'Turbo', value: krea2VersionIds.turbo },
  { label: 'Raw', value: krea2VersionIds.raw },
];

export const KREA2_EDIT_DEFAULT_VERSION_ID = krea2VersionIds.turbo;

/** Map version ID → FAL size string (only the medium/large FAL tiers). */
export const krea2VersionIdToSize = new Map<number, Krea2Size>([
  [krea2VersionIds.medium, 'medium'],
  [krea2VersionIds.large, 'large'],
]);

const krea2VersionIdToVariant = new Map<number, Krea2Variant>([
  [krea2VersionIds.medium, 'fal'],
  [krea2VersionIds.large, 'fal'],
  [krea2VersionIds.raw, 'raw'],
  [krea2VersionIds.turbo, 'turbo'],
]);

export const isOfficialKrea2Version = (id: number) => krea2VersionIdToVariant.has(id);

/** Krea renders ~1MP area buckets. */
const krea2AspectRatioDimensions: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1376, height: 768 },
  '4:3': { width: 1184, height: 896 },
  '3:2': { width: 1248, height: 832 },
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 928, height: 1152 },
  '2:3': { width: 832, height: 1248 },
  '9:16': { width: 768, height: 1376 },
};

/** 2K doubles each ~1MP bucket to ~4MP. */
const krea2ResolutionOptions = [
  { label: '1K', value: '1K' },
  { label: '2K', value: '2K' },
] as const;

/**
 * 2K: each ~1MP bucket doubled, then fitted. A straight doubling sends 16:9 as
 * 2752 × 1536 — past the comfy input's 2048 per side (and the 4 MP ceiling), so the
 * orchestrator refused every 2K ratio but 1:1. Fitting shrinks both sides together,
 * so each keeps its ratio: 16:9 is 2048 × 1152.
 */
const krea2AspectRatioOptionsFor = (scale: number) =>
  Object.keys(krea2AspectRatioDimensions).map((ratio) => {
    const { width, height } = krea2AspectRatioDimensions[ratio]!;
    const size =
      scale === 1
        ? { width, height }
        : fitCustomDimensions(
            { width: width * scale, height: height * scale },
            fourMegapixelCustomDimensionLimits
          )!;
    return { label: ratio, value: ratio, ...size };
  });

const krea2AspectRatioOptionsByResolution: Record<
  string,
  ReturnType<typeof krea2AspectRatioOptionsFor>
> = {
  '1K': krea2AspectRatioOptionsFor(1),
  '2K': krea2AspectRatioOptionsFor(2),
};

/** Edit and community checkpoints are comfy-only, so they keep the tier too. */
const krea2UsesComfyEngine = (modelId?: number, workflow?: string) =>
  workflow === 'img2img:edit' || modelId == null || !krea2VersionIdToSize.has(modelId);

const krea2PriorityRatios = ['16:9', '4:3', '1:1', '4:5', '9:16'];

const krea2CreativityOptions = [
  { label: 'Raw', value: 'raw' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
] as const;

export const KREA2_EDIT_IMAGES_LIMIT = 4;
export const KREA2_STYLE_REFERENCES_LIMIT = 10;
export const KREA2_STYLE_REFERENCE_STRENGTH_DEFAULT = 0.5;
const STRENGTH_MIN = 0;
const STRENGTH_MAX = 1;
const STRENGTH_STEP = 0.05;

const styleReferenceImageSchema = z.object({
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const styleReferenceEntryInputSchema = z.object({
  image: z.union([z.string(), styleReferenceImageSchema]).optional(),
  strength: z.number().min(STRENGTH_MIN).max(STRENGTH_MAX).optional(),
});

const styleReferenceEntryOutputSchema = z.object({
  image: styleReferenceImageSchema,
  strength: z.number().min(STRENGTH_MIN).max(STRENGTH_MAX),
});

export type Krea2StyleReferenceEntry = z.infer<typeof styleReferenceEntryOutputSchema>;

/** Entries without an image are dropped on the output side. */
const styleReferencesDef = {
  input: styleReferenceEntryInputSchema
    .array()
    .max(KREA2_STYLE_REFERENCES_LIMIT)
    .optional()
    .transform((arr) => {
      if (!arr) return undefined;
      return arr.map((entry) => {
        const image = typeof entry.image === 'string' ? { url: entry.image } : entry.image;
        const normalizedImage = image?.url ? image : undefined;
        return {
          image: normalizedImage,
          strength: entry.strength ?? KREA2_STYLE_REFERENCE_STRENGTH_DEFAULT,
        };
      });
    }),
  output: z
    .array(z.unknown())
    .max(
      KREA2_STYLE_REFERENCES_LIMIT,
      `Maximum ${KREA2_STYLE_REFERENCES_LIMIT} style references allowed`
    )
    .optional()
    .transform((arr) =>
      arr?.filter(
        (e): e is { image: { url: string }; strength: number } =>
          typeof e === 'object' &&
          e !== null &&
          'image' in e &&
          !!(e as { image?: { url?: string } }).image?.url
      )
    )
    .pipe(styleReferenceEntryOutputSchema.array().optional()),
  default: [] as Krea2StyleReferenceEntry[],
  // Staged references outlive the family they were staged under, so the limit they came
  // from is not the limit they end up under. `correct`, not `coerce`: the input above
  // carries the same `.max()`, so this can never fire on the server parse.
  correct: (value: Krea2StyleReferenceEntry[] | undefined) =>
    (value?.length ?? 0) > KREA2_STYLE_REFERENCES_LIMIT
      ? { value: value!.slice(0, KREA2_STYLE_REFERENCES_LIMIT), reason: 'over_cap' }
      : undefined,
  meta: {
    limit: KREA2_STYLE_REFERENCES_LIMIT,
    strength: {
      min: STRENGTH_MIN,
      max: STRENGTH_MAX,
      default: KREA2_STYLE_REFERENCE_STRENGTH_DEFAULT,
      step: STRENGTH_STEP,
    },
  },
};

type Krea2VariantExt = FamilyExt & { model?: unknown };

// Unknown ids are community checkpoints. Only the comfy builds can load one
// via `diffusionModel`, so they fall back off the FAL tiers — and to the
// full-step build, since turbo's 15-step / cfg-2 ceilings can't drive an
// undistilled model.
const variantOf = (ext: Krea2VariantExt): Krea2Variant => {
  const id = modelIdOf(ext.model);
  if (ext.workflow === 'img2img:edit')
    return id === krea2VersionIds.turbo ? 'editTurbo' : 'editRaw';
  return (id != null ? krea2VersionIdToVariant.get(id) : undefined) ?? 'raw';
};

const fal = defineGraph<Krea2VariantExt>()
  .field('creativity', enumDef({ options: krea2CreativityOptions, default: 'medium' }))
  .field('styleReferences', styleReferencesDef);

/** Raw: undistilled full-guidance build — ~52 steps at CFG 3.5 per model card. */
const raw = defineGraph<Krea2VariantExt>()
  .field('resources', familyResources)
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 3.5 }))
  .field('steps', perModelSlider({ min: 1, max: 60, default: 30 }));

/** Turbo: 8-step distilled build; guidance baked in, hence the cfg floor of 0. */
const turbo = defineGraph<Krea2VariantExt>()
  .field('resources', familyResources)
  .field('cfgScale', perModelSlider({ min: 0, max: 2, step: 0.1, default: 1 }))
  .field('steps', perModelSlider({ min: 1, max: 15, default: 8 }));

const editTurbo = defineGraph<Krea2VariantExt>()
  .field(
    'images',
    workflowScoped(() => imagesDef({ min: 1, max: KREA2_EDIT_IMAGES_LIMIT }))
  )
  .field('resources', familyResources)
  .field('cfgScale', perModelSlider({ min: 0, max: 2, step: 0.1, default: 1 }))
  .field('steps', perModelSlider({ min: 1, max: 15, default: 8 }));

const editRaw = defineGraph<Krea2VariantExt>()
  .field(
    'images',
    workflowScoped(() => imagesDef({ min: 1, max: KREA2_EDIT_IMAGES_LIMIT }))
  )
  .field('resources', familyResources)
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 3 }))
  .field('steps', perModelSlider({ min: 1, max: 60, default: 30 }));

/** Tagged: the picked key is stamped into state as `krea2Variant`. */
const variants = branch('krea2Variant', variantOf, { fal, raw, turbo, editRaw, editTurbo });

const RESOLUTION = enumDef({ options: krea2ResolutionOptions, default: '1K' });

/**
 * Custom sizes on the comfy builds only: they take any width × height (64–2048
 * /16), while the FAL tiers take a ratio label and nothing else. Grouped with the
 * ~4 MP models, the size the 2K tier reaches.
 */
const AR = defFamily((resolution: string, comfy: boolean) =>
  aspectRatioDef({
    options:
      krea2AspectRatioOptionsByResolution[resolution] ?? krea2AspectRatioOptionsByResolution['1K']!,
    default: '1:1',
    priorityOptions: krea2PriorityRatios,
    custom: comfy ? fourMegapixelCustomDimensionLimits : undefined,
  })
);

export const krea2 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) => {
    const isEdit = _ext.workflow === 'img2img:edit';
    return checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: isEdit ? krea2EditVersionOptions : krea2VersionOptions },
      defaultModelId: isEdit ? KREA2_EDIT_DEFAULT_VERSION_ID : krea2VersionIds.raw,
    });
  })
  .field('resolution', ({ model, _ext }) =>
    krea2UsesComfyEngine(modelIdOf(model) ?? undefined, _ext.workflow) ? RESOLUTION : null
  )
  .field('aspectRatio', ({ resolution, model, _ext }) =>
    AR(resolution ?? '1K', krea2UsesComfyEngine(modelIdOf(model) ?? undefined, _ext.workflow))
  )
  .use(variants)
  // negativePrompt exists only in the comfy variants; its in-branch snippet
  // registration never fires
  .use(
    makeTextBlock({
      negativePrompt: (ext) => variantOf(ext as Krea2VariantExt) !== 'fal',
      negativePromptRegistersTarget: false,
    })
  )
  .field('seed', SEED);

export { krea2VersionOptions, krea2EditVersionOptions };
