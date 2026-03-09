/**
 * Unified Configuration Types
 *
 * Workflow keys follow the format: {input}2{output}:{variant}
 * The first part describes the input→output transformation, the second is an optional variant.
 *
 * Examples:
 *   txt2img           → text to image creation
 *   img2img           → image to image (SD family)
 *   img2img:edit      → image editing (Qwen, Flux Kontext, etc.)
 *   txt2vid           → text to video
 *   img2vid           → image to video
 *   vid2vid:upscale   → video upscaling
 */

// =============================================================================
// Workflow Key Types
// =============================================================================

/** Output types */
export type OutputType = 'image' | 'video';

/** Full media type names */
export type MediaType = 'text' | 'image' | 'video';

/** UI category for grouping workflows */
export type WorkflowCategory = 'image' | 'video';

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

  /** Model version IDs that should NOT see this workflow */
  excludeModelVersionIds?: number[];

  /** Whether this is an enhancement workflow (e.g. upscale, remove-background) */
  enhancement?: boolean;

  /** Whether this workflow requires membership */
  memberOnly?: boolean;

  /** When true, no FormFooter (submit/quantity/reset) is shown for this workflow */
  noSubmit?: boolean;

  /** Short label for segmented mode control. Falls back to `label` if omitted. */
  modeLabel?: string;

  /**
   * How to display steps in the queue item.
   * - `'inline'` (default) — all step images in a single flat grid (e.g. batch upscale)
   * - `'separate'` — each step gets its own labeled section (e.g. generate → upscale pipeline)
   */
  stepDisplay?: 'inline' | 'separate';

  /**
   * Base workflow this is a variant of. Variants share the same graph branch
   * and submit as the base workflow, but have their own config (ecosystemIds,
   * excludeModelVersionIds, etc.). Used for mode switcher group resolution.
   */
  variantOf?: string;

  /** UI-only aliases — appear as additional entries in the workflow dropdown, all map to this key */
  aliases?: {
    label: string;
    description?: string;
    ecosystemIds: number[];
    /** Model version IDs that should NOT see this alias (e.g., Q3 doesn't support First/Last Frame) */
    excludeModelVersionIds?: number[];
  }[];
}

// =============================================================================
// Workflow Groups
// =============================================================================

/**
 * A workflow group defines workflows that can be toggled between via a segmented control.
 * Overrides allow specific ecosystems to show a different subset of workflows.
 */
export type WorkflowGroup = {
  /** All workflow keys in this group */
  workflows: string[];
  /** Ecosystem-specific overrides — show a different subset for certain ecosystems */
  overrides?: {
    ecosystemIds: number[];
    workflows: string[];
  }[];
};

// =============================================================================
// Workflow Configs Record
// =============================================================================

/** All workflow configs keyed by workflow key */
export type WorkflowConfigs = Record<string, WorkflowConfig>;
