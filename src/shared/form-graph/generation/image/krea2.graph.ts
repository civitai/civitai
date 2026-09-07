import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
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
 * Krea 2, ported from `krea2-graph.ts`. One locked checkpoint whose version
 * selector splits across two engines: medium/large are FAL size tiers
 * (creativity + style references, no LoRA), raw/turbo are comfy builds (LoRA,
 * negative prompt, cfg/steps). `img2img:edit` overrides the version into the
 * comfy edit variants and swaps the picker down to the two comfy builds.
 */

// ---- copied from krea2-graph.ts, which dies with the data-graph engine ------

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

/** Krea renders ~1MP area buckets — see krea2-graph.ts for the measurements. */
const krea2AspectRatioDimensions: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1376, height: 768 },
  '4:3': { width: 1184, height: 896 },
  '3:2': { width: 1248, height: 832 },
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 928, height: 1152 },
  '2:3': { width: 832, height: 1248 },
  '9:16': { width: 768, height: 1376 },
};

const krea2AspectRatioOptions = Object.keys(krea2AspectRatioDimensions).map((ratio) => {
  const { width, height } = krea2AspectRatioDimensions[ratio]!;
  return { label: ratio, value: ratio, width, height };
});

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

// ---- end of krea2-graph.ts copies -------------------------------------------

type Krea2VariantExt = FamilyExt & { model?: unknown };

// Unknown ids are community checkpoints. Only the comfy builds can load one
// via `diffusionModel`, so they fall back off the FAL tiers — and to the
// full-step build, since turbo's 15-step / cfg-2 ceilings can't drive an
// undistilled model. (v1 parity: kaydaxter's krea2-custom-checkpoints fix.)
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

/** Tagged: v1's `krea2Variant` computed becomes the branch key. */
const variants = branch('krea2Variant', variantOf, { fal, raw, turbo, editRaw, editTurbo });

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
  .field(
    'aspectRatio',
    aspectRatioDef({
      options: krea2AspectRatioOptions,
      default: '1:1',
      priorityOptions: krea2PriorityRatios,
    })
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
