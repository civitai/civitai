/**
 * Krea 2 Family Graph
 *
 * Controls for the Krea 2 ecosystem (Krea AI, FAL engine).
 * Model is locked; no LoRA support.
 *
 * Two model versions discriminated by size (matches Krea2FalImageGenInput.size):
 * - medium: lower-resolution tier
 * - large: higher-resolution tier
 *
 * Controls per Krea2FalImageGenInput:
 * - aspectRatio: 8 fixed ratios (1:1, 4:3, 3:2, 16:9, 2.35:1, 4:5, 2:3, 9:16)
 * - creativity: raw / low / medium / high
 * - styleReferences: up to 10 reference images with per-image strength (0–1)
 * - seed
 *
 * No negative prompt, no cfgScale, no steps.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  enumNode,
  promptGraph,
  seedNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';
import {
  type GenerationAspectRatio,
  getAspectRatioOptions,
} from '~/shared/constants/generation.constants';

// =============================================================================
// Version Constants
// =============================================================================

/** Krea 2 version IDs */
export const krea2VersionIds = {
  medium: 2983023,
  large: 2983022,
} as const;

export type Krea2Size = keyof typeof krea2VersionIds;

const krea2VersionOptions = [
  { label: 'Medium', value: krea2VersionIds.medium },
  { label: 'Large', value: krea2VersionIds.large },
];

/** Map version ID → size string (sent as `size` field to the orchestrator) */
export const krea2VersionIdToSize = new Map<number, Krea2Size>([
  [krea2VersionIds.medium, 'medium'],
  [krea2VersionIds.large, 'large'],
]);

// =============================================================================
// Aspect Ratios
// =============================================================================

/**
 * Krea 2's supported aspect ratios, restricted to the standard codebase set
 * defined by GenerationAspectRatio. The orchestrator picks actual output
 * dimensions based on the selected `size` tier, so display dimensions come
 * from the shared 1080p table for consistency with other ecosystems.
 *
 * (Krea's API also accepts '2.35:1', but it's a non-standard cinematic ratio
 * not part of GenerationAspectRatio — omitted to stay aligned with the rest of
 * the form.)
 */
const krea2AspectRatioList: GenerationAspectRatio[] = [
  '16:9',
  '4:3',
  '3:2',
  '1:1',
  '4:5',
  '2:3',
  '9:16',
];

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
// Krea 2 Graph
// =============================================================================

export const krea2Graph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: krea2VersionOptions },
        defaultModelId: krea2VersionIds.large,
      }),
    []
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .node(
    'aspectRatio',
    aspectRatioNode({
      options: getAspectRatioOptions('1080p', krea2AspectRatioList),
      defaultValue: '1:1',
      priorityOptions: krea2PriorityRatios,
    })
  )
  .node('creativity', enumNode({ options: krea2CreativityOptions, defaultValue: 'medium' }))
  .node('styleReferences', styleReferencesNode())
  .node('seed', seedNode());
