/**
 * Step Reference Helpers
 *
 * Utilities for building `$ref` objects that allow workflow steps to reference
 * earlier step outputs. The orchestrator API natively supports this mechanism —
 * this helper provides type-safe construction.
 *
 * Reference format: { $ref: '<stepName>', path: '<outputPath>' }
 * Convention: step names are '$0', '$1', etc. (matching their index in the steps array)
 */

// =============================================================================
// Types
// =============================================================================

/**
 * A reference to another step's output.
 * The orchestrator resolves these at runtime.
 */
export interface StepRef {
  $ref: string;
  path: string;
}

// =============================================================================
// Construction
// =============================================================================

/**
 * Builds a step reference for a given step index and output path.
 *
 * @param stepIndex - The index of the step to reference (becomes '$0', '$1', etc.)
 * @param outputPath - The path within the step's output (e.g., 'output.images[0].url')
 *
 * @example
 * buildStepRef(0, 'output.images[0].url')
 * // → { $ref: '$0', path: 'output.images[0].url' }
 */
export function buildStepRef(stepIndex: number, outputPath: string): StepRef {
  return { $ref: `$${stepIndex}`, path: outputPath };
}
