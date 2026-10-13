import * as z from 'zod';

import { videoValueSchema } from './media-schemas';
import type { SnippetReferenceValue } from './schemas/snippet-schema';

/**
 * The VALUE shapes the generation form's fields carry — resources, versions, controlnets,
 * control video, snippets.
 *
 * 🔴 NOTHING HERE MAY IMPORT A FORM OR GRAPH ENGINE. Most importers want the types alone, so
 * an engine import here drags the form runtime into all of them.
 */

/** Default weight bounds — matches orchestrator clamp. */
const CONTROLNET_WEIGHT_MIN = 0;

const CONTROLNET_WEIGHT_MAX = 2;

const CONTROLNET_STEP_MIN = 0;

const CONTROLNET_STEP_MAX = 1;

const controlNetImageObjectSchema = z.object({
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});

/**
 * Mode for an individual ControlNet entry:
 * - `auto` (default): the uploaded image is raw — the backend runs the
 *   preprocessor on it before feeding it into the matching ControlNet model.
 * - `preprocessed`: the user uploaded an already-preprocessed control image
 *   (e.g. they ran canny themselves) — skip preprocessing and route the image
 *   straight to the matching ControlNet model.
 *
 * The `preprocessor` field still picks the ControlNet model in both modes;
 * mode only governs whether preprocessing runs.
 */
export const controlNetModes = ['auto', 'preprocessed'] as const;

export type ControlNetMode = (typeof controlNetModes)[number];

const controlNetEntryOutputSchema = z.object({
  preprocessor: z.string(),
  mode: z.enum(controlNetModes),
  image: controlNetImageObjectSchema,
  weight: z.number().min(CONTROLNET_WEIGHT_MIN).max(CONTROLNET_WEIGHT_MAX),
  startStep: z.number().min(CONTROLNET_STEP_MIN).max(CONTROLNET_STEP_MAX),
  endStep: z.number().min(CONTROLNET_STEP_MIN).max(CONTROLNET_STEP_MAX),
});

/** Runtime value type for a single ControlNet entry. */
export type ControlNetEntryValue = z.infer<typeof controlNetEntryOutputSchema>;

/** Runtime value type for the controlNets node — a flat array of entries. */
export type ControlNetsNodeValue = ControlNetEntryValue[];

/**
 * Control strength bounds. The H3 Fun ControlNet Union treats 1.0 as the
 * strongest control and weakens below it, so 1 is a ceiling rather than the
 * middle of a range — unlike the image ControlNet weight, which goes to 2.
 */
const CONTROL_VIDEO_STRENGTH_MIN = 0;

const CONTROL_VIDEO_STRENGTH_MAX = 1;

const CONTROL_VIDEO_PERCENT_MIN = 0;

const CONTROL_VIDEO_PERCENT_MAX = 1;

const controlVideoOutputSchema = z.object({
  preprocessor: z.string(),
  mode: z.enum(controlNetModes),
  video: videoValueSchema,
  strength: z.number().min(CONTROL_VIDEO_STRENGTH_MIN).max(CONTROL_VIDEO_STRENGTH_MAX),
  startPercent: z.number().min(CONTROL_VIDEO_PERCENT_MIN).max(CONTROL_VIDEO_PERCENT_MAX),
  endPercent: z.number().min(CONTROL_VIDEO_PERCENT_MIN).max(CONTROL_VIDEO_PERCENT_MAX),
});

/** Runtime value type for the controlVideo node. */
export type ControlVideoNodeValue = z.infer<typeof controlVideoOutputSchema>;

/**
 * Minimal resource schema for graph validation.
 *
 * Only validates fields that the client needs to send:
 * - id: Required to identify the resource
 * - baseModel: Required for ecosystem switching when model changes
 * - model.type: Required for routing resources to appropriate graph nodes
 * - strength: Optional LoRA/LoCon/DoRA strength
 * - epochDetails: Optional epoch training info
 *
 * Server-side enrichment (via getResourceData) adds model.name, air, etc.
 * Handlers receive AIR strings via GenerationHandlerCtx instead of computing them.
 */
export const resourceSchema = z.object({
  id: z.number(),
  baseModel: z.string().optional(),
  model: z.object({
    type: z.string(),
  }),
  strength: z.number().optional(),
  trainedWords: z.array(z.string()).optional(),
  epochDetails: z
    .object({
      epochNumber: z.number().optional(),
    })
    .optional(),
  // Raw orchestrator-blob AIR resources (training epochs without a ModelVersion
  // row) — negative id + air + workflowId. See RawAirResource in shared/utils/air.
  air: z.string().optional(),
  workflowId: z.string().optional(),
  name: z.string().optional(),
});

/** Resource data type inferred from resourceSchema (minimal client-side data) */
export type ResourceData = z.infer<typeof resourceSchema>;

/**
 * Value type of the `resources` node — a flat array of `ResourceData`. Mirrors
 * the `SnippetsNodeValue` naming so callers reading the graph snapshot have a
 * canonical name to cast against (e.g. `graph.getSnapshot() as { resources?:
 * ResourcesNodeValue }`) instead of redeclaring the shape inline.
 */
export type ResourcesNodeValue = ResourceData[];

/**
 * Single version option for the model selector.
 * Can optionally have children for hierarchical selection (e.g., precision → variant).
 *
 * When `children` is present, `value` is the default model ID when this option is selected.
 * When `children` is absent (leaf), `value` is the actual model version ID.
 */
export type VersionOption = {
  label: string;
  value: number;
  /** Base model name for this version (used for ecosystem switching) */
  baseModel?: string;
  /** Child options shown when this option is selected */
  children?: VersionGroup;
};

/**
 * Group of version options with an optional label.
 * The label is displayed above the selector control in the UI.
 *
 * @example
 * // Flat versions (Flux modes):
 * { options: [{ label: 'Draft', value: 123 }, { label: 'Standard', value: 456 }] }
 *
 * // Hierarchical versions (HiDream precision + variant):
 * {
 *   label: 'Precision',
 *   options: [
 *     { label: 'FP8', value: 1771369, children: {
 *       label: 'Variant',
 *       options: [{ label: 'Fast', value: 1770945 }, { label: 'Dev', value: 1771369 }]
 *     }},
 *   ]
 * }
 */
export type VersionGroup = {
  /** Optional label for this level of the selector (e.g., "Precision", "Variant") */
  label?: string;
  /** Available options at this level */
  options: VersionOption[];
};

/** @deprecated Use VersionOption instead */
export type CheckpointVersionOption = VersionOption;

/**
 * Collect all version IDs from a VersionGroup (including nested children).
 * Used for validation and version ID pre-registration.
 */
export function getAllVersionIds(group: VersionGroup): Set<number> {
  const ids = new Set<number>();
  function collect(g: VersionGroup) {
    for (const opt of g.options) {
      ids.add(opt.value);
      if (opt.children) collect(opt.children);
    }
  }
  collect(group);
  return ids;
}

export type SnippetsNodeValue = {
  wildcardSetIds: number[];
  mode: 'random' | 'batch';
  batchCount: number;
  seed?: number;
  targets: Record<string, SnippetReferenceValue[]>;
};

/** Video metadata type */
export type VideoMetadata = {
  fps: number;
  width: number;
  height: number;
  duration: number;
};

/** Video value type (URL with optional metadata) */
export type VideoValue = {
  url: string;
  metadata?: VideoMetadata;
};

export type SnippetReference = SnippetReferenceValue;

// re-exported here so a consumer needs one import, not two.
export { MAX_PROMPT_LENGTH } from '~/shared/constants/generation.constants';
