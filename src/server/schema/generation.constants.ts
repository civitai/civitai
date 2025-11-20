/**
 * Generation constants used by schemas.
 * Extracted to avoid circular dependencies between generation.constants.ts and generation.schema.ts.
 *
 * Strategy: Extract Shared Code (Strategy 1)
 * - Schemas should NEVER import from feature constants files
 * - This file contains only the primitive values needed for validation
 */

export const GENERATION_MAX_VALUES = {
  seed: 4294967295,
  clipSkip: 3,
} as const;
