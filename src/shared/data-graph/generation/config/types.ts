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
export type OutputType = 'image' | 'video' | 'audio';

/** Full media type names */
export type MediaType = 'text' | 'image' | 'video' | 'audio';

/** UI category for grouping workflows */
export type WorkflowCategory = 'image' | 'video' | 'audio';

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

  /**
   * When true, the form auto-navigates back to the previous workflow after
   * submit and clears the source media. Suits one-shot enhancement flows
   * (upscale, remove-background) where the user popped in to do one thing.
   *
   * Leave unset for workflows where users typically iterate on the same
   * source (e.g. preprocess — try a different `kind` on the same image).
   * Independent of `enhancement` so source-metadata lineage and picker
   * placement aren't bundled with the post-submit UX.
   */
  returnAfterSubmit?: boolean;

  /**
   * When true, the workflow header renders a back-button so the user can
   * leave. Set this for any workflow without an ecosystem picker or other
   * obvious in-form navigation path (upscale, remove-bg, preprocess, etc.).
   */
  showBackButton?: boolean;

  /**
   * If set, the workflow is hidden from the picker unless the matching
   * Flipt feature flag is enabled. Must be a key from `useFeatureFlags()`
   * (the returned `features` object). String-typed rather than strictly
   * typed to keep server-side workflow configs free of client-only types.
   *
   * @example
   *   featureFlag: 'wan22MultiStep'  // hide unless features.wan22MultiStep is true
   */
  featureFlag?: string;

  /** Whether this workflow requires membership */
  memberOnly?: boolean;

  /** When true, no FormFooter (submit/quantity/reset) is shown for this workflow */
  noSubmit?: boolean;

  /** When true, this workflow is hidden from the workflow picker (triggered programmatically) */
  hidden?: boolean;

  /** When true, the workflow picker shows a "New" badge next to the label */
  isNew?: boolean;

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
