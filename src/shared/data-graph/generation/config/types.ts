/**
 * Unified Configuration Types
 *
 * Workflow keys follow the format: {input}2{output} or {input}2{output}:{variant}
 * This allows input/output types to be inferred from the key itself.
 *
 * Examples:
 *   txt2img        → input: text, output: image
 *   img2img:edit   → input: image, output: image, variant: edit
 *   img2vid:animate → input: image, output: video, variant: animate
 *
 * Layered config system:
 * 1. WorkflowConfig - base settings per workflow
 * 2. Ecosystem overrides - per ecosystem within a workflow
 * 3. ModelVersion overrides - per version or version group
 *
 * Priority (most specific wins): version > ecosystem > workflow
 */

// =============================================================================
// Workflow Key Types
// =============================================================================

/** Media type abbreviations used in workflow keys */
export type MediaTypeAbbrev = 'txt' | 'img' | 'vid';

/** Full media type names */
export type MediaType = 'text' | 'image' | 'video';

/** Map from abbreviation to full name */
const mediaTypeMap: Record<MediaTypeAbbrev, MediaType> = {
  txt: 'text',
  img: 'image',
  vid: 'video',
};

/** Workflow key format: {input}2{output} or {input}2{output}:{variant} */
export type WorkflowKey =
  | `${MediaTypeAbbrev}2${MediaTypeAbbrev}`
  | `${MediaTypeAbbrev}2${MediaTypeAbbrev}:${string}`;

/** Parsed workflow key components */
export interface ParsedWorkflowKey {
  input: MediaType;
  output: MediaType;
  variant?: string;
}

/**
 * Parse a workflow key to extract input/output types and variant.
 * @throws Error if key doesn't match expected format
 */
export function parseWorkflowKey(key: string): ParsedWorkflowKey {
  const match = key.match(/^(txt|img|vid)2(txt|img|vid)(?::(.+))?$/);
  if (!match) {
    throw new Error(
      `Invalid workflow key: "${key}". Expected format: {txt|img|vid}2{txt|img|vid} or {txt|img|vid}2{txt|img|vid}:{variant}`
    );
  }

  return {
    input: mediaTypeMap[match[1] as MediaTypeAbbrev],
    output: mediaTypeMap[match[2] as MediaTypeAbbrev],
    variant: match[3],
  };
}

/**
 * Get the input type from a workflow key.
 */
export function getInputType(key: string): MediaType {
  return parseWorkflowKey(key).input;
}

/**
 * Get the output type from a workflow key.
 */
export function getOutputType(key: string): MediaType {
  return parseWorkflowKey(key).output;
}

// =============================================================================
// Common Types
// =============================================================================

/** UI category for grouping workflows */
export type WorkflowCategory =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'image-enhancements'
  | 'video-enhancements';

/** Image slot configuration for multi-image inputs */
export interface ImageSlotConfig {
  label: string;
  required?: boolean;
}

/** Image input configuration */
export interface ImagesNodeConfig {
  max?: number;
  min?: number;
  slots?: ImageSlotConfig[];
}

/** Node configs that can be overridden */
export interface NodeConfigs {
  images?: ImagesNodeConfig;
}

// =============================================================================
// Workflow Config
// =============================================================================

/**
 * Configuration for a workflow.
 * Combines UI metadata with node configuration.
 */
export interface WorkflowConfig {
  /** Display label for the workflow */
  label: string;

  /** Brief description of what this workflow does */
  description?: string;

  /** UI category for grouping */
  category: WorkflowCategory;

  /** Ecosystem IDs that support this workflow */
  ecosystemIds: number[];

  /** Base node configurations */
  nodes?: NodeConfigs;

  /** Ecosystem-specific overrides (by ecosystem key) */
  ecosystemOverrides?: Record<string, Partial<NodeConfigs>>;

  /**
   * Model version overrides.
   * Key can be a single version ID or comma-separated IDs for groups.
   * Example: { '123456': {...}, '789,790,791': {...} }
   */
  versionOverrides?: Record<string, Partial<NodeConfigs>>;
}

// =============================================================================
// Workflow Configs Record
// =============================================================================

/** All workflow configs keyed by workflow key */
export type WorkflowConfigs = Partial<Record<WorkflowKey, WorkflowConfig>>;
