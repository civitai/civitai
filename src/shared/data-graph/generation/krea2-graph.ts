/**
 * Krea 2 Family Graph
 *
 * Controls for the Krea 2 ecosystem. The version selector offers four official
 * variants that split across two engines (community checkpoints take the raw
 * control set):
 *
 * FAL engine (Krea2FalImageGenInput) — size tiers, no LoRA:
 * - medium: smaller/faster model
 * - large:  larger, higher-quality model
 *   Both render at the same ~1K resolution (the tier is model size, not image
 *   size). Controls: aspectRatio / creativity / styleReferences / seed.
 *
 * Comfy engine (ComfyKrea2Raw/TurboCreateImageGenInput) — LoRA support:
 * - raw:   full-step variant
 * - turbo: distilled, low-step variant
 *   Controls: aspectRatio / resources (LoRA) / negativePrompt / cfgScale / steps / seed.
 *
 * The selected version is mapped to a `krea2Variant` discriminator that swaps in
 * the engine-appropriate controls. `img2img:edit` maps to editRaw/editTurbo —
 * still per-version, because Krea 2 exposes editing as an operation on either
 * build, not as its own build.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import {
  aspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  enumNode,
  imagesNode,
  negativePromptGraph,
  promptGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';
import type {
  AspectRatioDimensions,
  GenerationAspectRatio,
} from '~/shared/constants/generation.constants';

// =============================================================================
// Version Constants
// =============================================================================

/**
 * Krea 2 version IDs.
 *
 * medium/large are the FAL size tiers (no LoRA). raw/turbo are the comfy,
 * LoRA-capable variants.
 */
export const krea2VersionIds = {
  medium: 2983023,
  large: 2983022,
  raw: 3072329,
  turbo: 3072332,
} as const;

/** FAL size tiers (the orchestrator picks output dimensions from this). */
export type Krea2Size = 'medium' | 'large';

/** Control-set discriminator derived from the selected version. */
type Krea2Variant = 'fal' | 'raw' | 'turbo' | 'editRaw' | 'editTurbo';

const krea2VersionOptions = [
  { label: 'Medium', value: krea2VersionIds.medium },
  { label: 'Large', value: krea2VersionIds.large },
  { label: 'Raw', value: krea2VersionIds.raw },
  { label: 'Turbo', value: krea2VersionIds.turbo },
];

/**
 * Edit has no checkpoint of its own — it runs either Krea 2 build plus the
 * identity-edit LoRA and a pair of conditioning nodes, so the selected version
 * is both the base the handler sends as `diffusionModel` and the resource the
 * generation is attributed to. Turbo is the default fast path; Raw is what the
 * upstream notes recommend for removals.
 * @see https://github.com/lbouaraba/comfyui-krea2edit
 */
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

// =============================================================================
// Aspect Ratios
// =============================================================================

/**
 * Display dimensions for Krea 2's FAL size tiers, restricted to the standard
 * codebase set defined by GenerationAspectRatio (and their listed order in the
 * form). Both the medium and large tiers output the same size — "large" is a
 * bigger model, not a bigger image. The FAL API takes only `size` +
 * `aspectRatio` (no width/height), so these values are display-only; the
 * orchestrator derives the real output.
 *
 * Krea renders ~1MP area buckets (each side divisible by 32), not a fixed
 * short-side, so the shared 1080p table was doubly wrong. The 16:9 / 4:3 / 3:2
 * / 1:1 / 4:5 values are measured from real generations; 2:3 and 9:16 are the
 * transposes of 3:2 and 16:9 (Krea doesn't expose them in the size-tier form to
 * measure directly, but the bucket set is symmetric).
 *
 * (Krea's API also accepts '2.35:1', but it's a non-standard cinematic ratio
 * not part of GenerationAspectRatio — omitted to stay aligned with the rest of
 * the form.)
 */
const krea2AspectRatioDimensions = {
  '16:9': { width: 1376, height: 768 },
  '4:3': { width: 1184, height: 896 },
  '3:2': { width: 1248, height: 832 },
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 928, height: 1152 },
  '2:3': { width: 832, height: 1248 },
  '9:16': { width: 768, height: 1376 },
} satisfies Partial<Record<GenerationAspectRatio, AspectRatioDimensions>>;

const krea2AspectRatioOptions = (
  Object.keys(krea2AspectRatioDimensions) as (keyof typeof krea2AspectRatioDimensions)[]
).map((ratio) => {
  const { width, height } = krea2AspectRatioDimensions[ratio];
  return { label: ratio, value: ratio, width, height };
});

/** Standard preferred ratios — substitute 4:5 for 3:4 since Krea lacks 3:4. */
const krea2PriorityRatios = ['16:9', '4:3', '1:1', '4:5', '9:16'];

// =============================================================================
// Creativity
// =============================================================================

const krea2CreativityOptions = [
  { label: 'Raw', value: 'raw' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
] as const;

// =============================================================================
// Style References
// =============================================================================

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

/**
 * Style references node — mirrors the controlnet input shape: a list of
 * entries, each with an optional image + a strength slider. Entries without an
 * image are dropped on the output side so the orchestrator only sees usable
 * references.
 */
function styleReferencesNode() {
  return {
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
    // Filter out entries without an image, then validate the remaining
    // entries against the output schema (where `image` is required).
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
    defaultValue: [] as Krea2StyleReferenceEntry[],
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
}

// =============================================================================
// Variant Subgraphs
// =============================================================================

/** Context shape passed to the krea2 variant subgraphs. */
type Krea2VariantCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData;
  krea2Variant: Krea2Variant;
};

/** FAL variant (medium/large): creativity + style references, no LoRA. */
const falVariantGraph = new DataGraph<Krea2VariantCtx, GenerationCtx>()
  .node('creativity', enumNode({ options: krea2CreativityOptions, defaultValue: 'medium' }))
  .node('styleReferences', styleReferencesNode());

/**
 * Comfy raw variant (Krea 2 RAW): undistilled, full-guidance build.
 * Defaults follow Krea's model card — ~52 steps at CFG 3.5. LoRA + negative
 * prompt support.
 */
const rawVariantGraph = new DataGraph<Krea2VariantCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .merge(negativePromptGraph)
  .node('cfgScale', sliderNode({ min: 1, max: 10, step: 0.5, defaultValue: 3.5 }))
  .node('steps', sliderNode({ min: 1, max: 60, defaultValue: 30 }));

/**
 * Comfy turbo variant: 8-step distilled build. Guidance is baked into the
 * weights, so Krea's model card runs it at CFG 0.0 / 8 steps — hence the cfg
 * floor of 0. LoRA + negative prompt support.
 */
const turboVariantGraph = new DataGraph<Krea2VariantCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .merge(negativePromptGraph)
  .node('cfgScale', sliderNode({ min: 0, max: 2, step: 0.1, defaultValue: 1 }))
  .node('steps', sliderNode({ min: 1, max: 15, defaultValue: 8 }));

/**
 * Comfy edit variants (`model: 'edit'` on the wire, base picked via
 * `diffusionModel`): the comfy control set plus the source images being edited.
 * Selected by the `img2img:edit` workflow rather than by a version — edit is a
 * Krea 2 build plus the identity-edit LoRA, an operation on the existing
 * offering rather than a separate build. Community Krea 2 LoRAs stack on top of
 * the identity-edit LoRA the orchestrator applies.
 *
 * Step/cfg defaults track the upstream guidance per base: turbo runs 8 steps at
 * CFG 1, raw runs at CFG 3.
 */
const editBaseGraph = () =>
  new DataGraph<Krea2VariantCtx, GenerationCtx>()
    .node('images', imagesNode({ min: 1, max: KREA2_EDIT_IMAGES_LIMIT }))
    .merge(createResourcesGraph())
    .merge(negativePromptGraph);

const editTurboVariantGraph = editBaseGraph()
  .node('cfgScale', sliderNode({ min: 0, max: 2, step: 0.1, defaultValue: 1 }))
  .node('steps', sliderNode({ min: 1, max: 15, defaultValue: 8 }));

const editRawVariantGraph = editBaseGraph()
  .node('cfgScale', sliderNode({ min: 1, max: 10, step: 0.5, defaultValue: 3 }))
  .node('steps', sliderNode({ min: 1, max: 60, defaultValue: 30 }));

// =============================================================================
// Krea 2 Graph
// =============================================================================

export const krea2Graph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  // Edit runs on the comfy builds only, so the FAL size tiers drop out of the
  // picker there — the remaining choice is the base the request actually uses.
  .merge(
    (ctx) => {
      const isEdit = ctx.workflow === 'img2img:edit';
      return createCheckpointGraph({
        versions: { options: isEdit ? krea2EditVersionOptions : krea2VersionOptions },
        defaultModelId: isEdit ? KREA2_EDIT_DEFAULT_VERSION_ID : krea2VersionIds.raw,
      });
    },
    ['workflow']
  )
  .node(
    'aspectRatio',
    aspectRatioNode({
      options: krea2AspectRatioOptions,
      defaultValue: '1:1',
      priorityOptions: krea2PriorityRatios,
    })
  )
  // Unknown ids are community checkpoints. Only the comfy builds can load one via
  // `diffusionModel`, so they fall back off the FAL tiers — and to the full-step
  // build, since turbo's 15-step / cfg-2 ceilings can't drive an undistilled model.
  .computed(
    'krea2Variant',
    (ctx): Krea2Variant => {
      if (ctx.workflow === 'img2img:edit')
        return ctx.model?.id === krea2VersionIds.turbo ? 'editTurbo' : 'editRaw';
      return (ctx.model?.id ? krea2VersionIdToVariant.get(ctx.model.id) : undefined) ?? 'raw';
    },
    ['model', 'workflow']
  )
  .discriminator('krea2Variant', {
    fal: falVariantGraph,
    raw: rawVariantGraph,
    turbo: turboVariantGraph,
    editRaw: editRawVariantGraph,
    editTurbo: editTurboVariantGraph,
  })
  // Prompt + triggerWords are common to all variants. negativePrompt lives in
  // the comfy branches; its registration effect self-adds to the snippets
  // target map when that branch is active.
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .node('seed', seedNode());
