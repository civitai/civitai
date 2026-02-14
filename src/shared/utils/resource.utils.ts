/**
 * Resource Utilities
 *
 * Shared utilities for working with generation resources.
 * Used by both client and server code.
 */

import { allInjectableResourceIds } from '~/shared/constants/generation.constants';

// =============================================================================
// Types
// =============================================================================

/** Minimal resource shape for splitting/combining operations */
type ResourceLike = { id: number; model: { type: string } };

/** Step metadata storage format (legacy format, used for persistence) */
export type StepMetadataFormat<T extends ResourceLike> = {
  resources: T[];
  params: Record<string, unknown>;
};

// =============================================================================
// Split: flat resources[] → { model, resources, vae }
// =============================================================================

/**
 * Splits a flat array of resources into model, additional resources, and vae by model type.
 * Filters out injectable resources (draft LoRAs) since those are auto-injected
 * by the new system and should not be stored as user-selected resources.
 *
 * Generic over the resource type — works with both `GenerationResource` (rich)
 * and any object with `{ id, model: { type } }`.
 *
 * @example
 * ```ts
 * const allResources = await fetchGenerationData({ type: 'modelVersion', id });
 * const { model, resources, vae } = splitResourcesByType(allResources.resources);
 * graph.set({ model, resources, vae });
 * ```
 */
export function splitResourcesByType<T extends ResourceLike>(
  resources: T[]
): { model?: T; resources: T[]; vae?: T } {
  // Filter out injectable resources (draft LoRAs etc.)
  const userResources = resources.filter((r) => !allInjectableResourceIds.includes(r.id));

  const model = userResources.find(
    (r) => r.model.type === 'Checkpoint' || r.model.type === 'Upscaler'
  );
  const vae = userResources.find((r) => r.model.type === 'VAE');
  const additional = userResources.filter(
    (r) => r.model.type !== 'Checkpoint' && r.model.type !== 'Upscaler' && r.model.type !== 'VAE'
  );

  return { model, resources: additional, vae };
}

// =============================================================================
// Combine: { model, resources, vae } → flat resources[]
// =============================================================================

/**
 * Combines model, additional resources, and vae into a flat array.
 * Inverse of splitResourcesByType.
 *
 * @example
 * ```ts
 * const flatResources = combineResources({ model, resources, vae });
 * ```
 */
export function combineResources<T extends ResourceLike>({
  model,
  resources = [],
  vae,
}: {
  model?: T;
  resources?: T[];
  vae?: T;
}): T[] {
  const result: T[] = [];
  if (model) result.push(model);
  result.push(...resources);
  if (vae) result.push(vae);
  return result;
}

// =============================================================================
// Convert: graph output → step metadata format
// =============================================================================

/**
 * Converts generation-graph output to step metadata storage format.
 * Combines model/resources/vae into a flat resources array and extracts
 * all other fields into params.
 *
 * This is the inverse of what mapLegacyMetadata does - use this when
 * creating generation requests to store in the legacy {resources, params} format.
 *
 * @example
 * ```ts
 * const graphOutput = graph.output();
 * const { resources, params } = toStepMetadata(graphOutput);
 * // Store as step.metadata = { resources, params }
 * ```
 */
export function toStepMetadata<T extends ResourceLike>(
  graphOutput: Record<string, unknown> & {
    model?: T;
    resources?: T[];
    vae?: T;
  }
): StepMetadataFormat<T> {
  const { model, resources: additionalResources, vae, ...params } = graphOutput;

  const resources = combineResources({
    model,
    resources: additionalResources,
    vae,
  });

  return { resources, params };
}

// =============================================================================
// Convert: step metadata format → graph input
// =============================================================================

/**
 * Converts step metadata storage format to generation-graph input format.
 * Splits flat resources array into model/resources/vae and merges with params.
 *
 * This is essentially what the client needs to do when loading saved generation data.
 *
 * @example
 * ```ts
 * const { resources, params } = step.metadata;
 * const graphInput = fromStepMetadata({ resources, params });
 * graph.set(graphInput);
 * ```
 */
export function fromStepMetadata<T extends ResourceLike>({
  resources,
  params,
}: StepMetadataFormat<T>): Record<string, unknown> & { model?: T; resources: T[]; vae?: T } {
  const split = splitResourcesByType(resources);
  return {
    ...params,
    model: split.model,
    resources: split.resources,
    vae: split.vae,
  };
}
