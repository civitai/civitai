/**
 * Step Metadata Helpers
 *
 * Pure functions for building and resolving step-level metadata.
 *
 * All params/resources/flags live on step.metadata. For enhancement workflows,
 * step.metadata also includes a `source` field with the original generation's
 * params/resources.
 *
 * Write path: builds step.metadata with source for enhancements.
 * Read path: resolves source from either new format (step.metadata.source)
 *            or legacy (step.metadata root + transformations[]).
 */

// =============================================================================
// Types
// =============================================================================

export interface StepSource {
  params?: Record<string, unknown>;
  resources?: Array<Record<string, unknown>>;
  /** Flags from the original generation (remixOfId, isPrivateGeneration, etc.) */
  [key: string]: unknown;
}

/** Legacy transformation entry — only used for backward-compatible reading */
export interface StepMetadataTransformation {
  workflow: string;
  params?: Record<string, unknown>;
  resources?: Array<Record<string, unknown>>;
}

// =============================================================================
// Write Path
// =============================================================================

/**
 * Builds the `source` field for an enhancement step's metadata.
 * Records the original generation's params/resources so users can
 * "remix from original" after an enhancement chain.
 *
 * @param sourceMetadata - The original generation's params/resources
 * @returns Object with `source` field, or undefined if no source metadata
 */
export function buildStepSource(
  sourceMetadata: StepSource | undefined
): { source: StepSource } | undefined {
  if (!sourceMetadata) return undefined;
  const { params, resources, ...flags } = sourceMetadata;
  return {
    source: {
      params: params ?? {},
      resources: resources ?? [],
      ...flags,
    },
  };
}

// =============================================================================
// Read Path
// =============================================================================

/**
 * Resolves the source metadata for an enhancement step.
 *
 * - New format: `step.metadata.source` has the original generation's params/resources
 * - Legacy with transformations: `step.metadata.params/resources` IS the original generation
 *   (transformations[] contains the enhancement chain)
 * - Legacy without transformations: not an enhancement, returns undefined
 */
export function resolveStepSource(stepMeta: Record<string, unknown>): StepSource | undefined {
  // New format: explicit source field
  if (stepMeta.source && typeof stepMeta.source === 'object') {
    return stepMeta.source as StepSource;
  }

  // Legacy: if transformations exist, step.metadata root IS the original generation
  const transformations = stepMeta.transformations as StepMetadataTransformation[] | undefined;
  if (Array.isArray(transformations) && transformations.length > 0) {
    const { params, resources, transformations: _, images: __, ...flags } = stepMeta;
    return {
      params: (params as Record<string, unknown>) ?? {},
      resources: (resources as Array<Record<string, unknown>>) ?? [],
      ...flags,
    };
  }

  // No source — this is not an enhancement workflow
  return undefined;
}
