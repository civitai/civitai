/**
 * Shared utilities for ResourceSelectInput and ResourceSelectMultipleInput
 *
 * Contains common types, hydration helpers, and UI components used by both
 * single and multiple resource selection inputs.
 */

import { Group, Skeleton } from '@mantine/core';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';

// =============================================================================
// Types
// =============================================================================

/** Resource data as returned by ResourceDataProvider (GenerationResource with air field) */
export type ResourceData = GenerationResource & { air: string };

/**
 * Value type for resource select inputs - stores the full GenerationResource.
 * Input schema accepts just an id (number) and the component hydrates to full resource.
 */
export type ResourceSelectValue = GenerationResource;

/**
 * Partial resource value that can be passed to the input.
 * This matches what DataGraph validation schema outputs.
 */
export type PartialResourceValue = Partial<GenerationResource> & { id: number };

// =============================================================================
// Hydration Helpers
// =============================================================================

/**
 * Helper to check if a value needs hydration.
 * A value needs hydration if it's missing essential fields like model or name.
 * This can happen when the value came from URL params, minimal input, or DataGraph defaults.
 *
 * DataGraph defaults only include { id, baseModel, model: { type } } - no name fields.
 */
export function needsHydration(value: PartialResourceValue | undefined): boolean {
  if (!value) return false;
  // If we're missing name or model.name, we need to hydrate
  return !isFullyHydrated(value);
}

/**
 * Helper to check if a value is fully hydrated (has all required data).
 * Used to display resource data from localStorage before fetch completes.
 */
export function isFullyHydrated(value: PartialResourceValue): value is ResourceSelectValue {
  return 'model' in value && !!value.model && 'name' in value && !!value.name;
}

// =============================================================================
// Options Helpers
// =============================================================================

/**
 * Resolves resource options, adding resourceType filter if not already set.
 * Used by both single and multiple resource select inputs.
 */
export function resolveResourceOptions(
  options: ResourceSelectOptions,
  resourceType?: 'Checkpoint' | 'LORA' | 'VAE' | 'TextualInversion'
): ResourceSelectOptions {
  // Add resourceType filter if provided and options.resources not already set
  if (resourceType && !options?.resources?.length) {
    return { ...options, resources: [{ type: resourceType }] };
  }
  return options;
}

// =============================================================================
// UI Components
// =============================================================================

/**
 * Loading skeleton for a resource card.
 * Used when resource data is being fetched.
 */
export function ResourceCardSkeleton() {
  return (
    <div className="rounded-lg border border-solid border-gray-3 bg-gray-0 p-2 dark:border-dark-4 dark:bg-dark-6">
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Skeleton height={20} width="60%" />
        <Group gap={4}>
          <Skeleton height={24} width={50} radius="xl" />
          <Skeleton height={24} width={24} radius="sm" />
        </Group>
      </Group>
    </div>
  );
}

/**
 * Inline loading skeleton for resource items in a list.
 * More compact than ResourceCardSkeleton.
 */
export function ResourceItemSkeleton() {
  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Skeleton height={20} width="60%" />
      <Skeleton height={24} width={24} radius="sm" />
    </Group>
  );
}
