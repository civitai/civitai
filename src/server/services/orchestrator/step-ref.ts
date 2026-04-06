/**
 * Step Reference Helpers
 *
 * Utilities for building `$ref` objects that allow workflow steps to reference
 * earlier step outputs. The orchestrator API natively supports this mechanism —
 * these helpers provide type-safe construction and detection.
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
// Detection
// =============================================================================

/**
 * Type guard: checks if a value is a step reference object.
 *
 * Step creators use this to detect `$ref` objects vs actual URLs in image/video fields.
 * When a `$ref` is detected, the value is passed through to the step input untouched
 * (the orchestrator resolves it at runtime).
 */
export function isStepRef(value: unknown): value is StepRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$ref' in value &&
    'path' in value &&
    typeof (value as StepRef).$ref === 'string' &&
    typeof (value as StepRef).path === 'string'
  );
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

// =============================================================================
// Output Path Resolution
// =============================================================================

/** Output type produced by a workflow step */
export type StepOutputType = 'image' | 'video';

/**
 * Returns the `$ref` output path for a step that produces the given output type.
 *
 * Output shapes (from the orchestrator API):
 * - image workflows (textToImage, imageGen, comfy, imageUpscaler): `output.images[N].url`
 * - video workflows (videoGen): `output.video.url`
 *
 * @param outputType - The output type of the step ('image' or 'video')
 * @param imageIndex - For image outputs, which image to reference (default 0)
 */
export function getOutputRefPath(outputType: StepOutputType, imageIndex = 0): string {
  return outputType === 'video' ? 'output.video.url' : `output.images[${imageIndex}].url`;
}

/**
 * Builds a complete `$ref` to a preceding step's output, given the step index
 * and the output type of that step.
 *
 * @example
 * // txt2img (image output) at step 0 → ref for step 1's image input
 * buildStepOutputRef(0, 'image')
 * // → { $ref: '$0', path: 'output.images[0].url' }
 *
 * @example
 * // videoGen at step 0 → ref for step 1's video input
 * buildStepOutputRef(0, 'video')
 * // → { $ref: '$0', path: 'output.video.url' }
 */
export function buildStepOutputRef(
  stepIndex: number,
  outputType: StepOutputType,
  imageIndex = 0
): StepRef {
  return buildStepRef(stepIndex, getOutputRefPath(outputType, imageIndex));
}

// =============================================================================
// Step Naming
// =============================================================================

/**
 * Assigns sequential names ('$0', '$1', ...) to workflow steps so they can be
 * referenced by later steps via `$ref`.
 *
 * Returns new step objects with the `name` field set — does not mutate the originals.
 *
 * @param steps - Array of step templates (with $type, input, metadata, etc.)
 */
export function assignStepNames<T extends Record<string, unknown>>(
  steps: T[]
): (T & { name: string })[] {
  return steps.map((step, i) => ({
    ...step,
    name: `$${i}`,
  }));
}
