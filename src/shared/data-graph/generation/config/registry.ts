/**
 * Config Lookup Functions
 *
 * Simple functions to get merged node configs with proper priority:
 * version > ecosystem > workflow
 */

import type { WorkflowConfigs, NodeConfigs, ImagesNodeConfig } from './types';

// =============================================================================
// Deep Merge Utility
// =============================================================================

/**
 * Deep merge two objects, where source values override target values.
 * Arrays are replaced, not merged.
 */
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (sourceValue === null || sourceValue === false) {
      // Explicit null/false means "disable this"
      result[key] = sourceValue as T[keyof T];
    } else if (
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue) &&
      targetValue !== null
    ) {
      // Recursively merge objects
      result[key] = deepMerge(targetValue as object, sourceValue as object) as T[keyof T];
    } else {
      // Replace primitives and arrays
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

// =============================================================================
// Version Override Lookup
// =============================================================================

/**
 * Find version overrides that match the given version ID.
 * Supports both single IDs and comma-separated groups.
 */
function findVersionOverrides(
  versionOverrides: Record<string, Partial<NodeConfigs>> | undefined,
  versionId: number
): Partial<NodeConfigs> | undefined {
  if (!versionOverrides) return undefined;

  const versionStr = String(versionId);

  // Check for exact match first
  if (versionOverrides[versionStr]) {
    return versionOverrides[versionStr];
  }

  // Check for group matches (comma-separated IDs)
  for (const key of Object.keys(versionOverrides)) {
    if (key.includes(',')) {
      const ids = key.split(',').map((id) => id.trim());
      if (ids.includes(versionStr)) {
        return versionOverrides[key];
      }
    }
  }

  return undefined;
}

// =============================================================================
// Config Lookup Functions
// =============================================================================

/**
 * Get merged node config for a workflow + ecosystem + version combination.
 *
 * Priority (most specific wins):
 * 1. Version overrides (by version ID or group)
 * 2. Ecosystem overrides
 * 3. Workflow base nodes
 */
export function getNodeConfig(
  configs: WorkflowConfigs,
  workflowKey: string,
  ecosystemKey: string,
  versionId?: number
): NodeConfigs {
  const workflow = configs[workflowKey as keyof WorkflowConfigs];
  if (!workflow) return {};

  // Start with workflow base config
  let config: NodeConfigs = { ...(workflow.nodes ?? {}) };

  // Apply ecosystem overrides
  const ecosystemOverrides = workflow.ecosystemOverrides?.[ecosystemKey];
  if (ecosystemOverrides) {
    config = deepMerge(config, ecosystemOverrides);
  }

  // Apply version overrides
  if (versionId) {
    const versionOverrides = findVersionOverrides(workflow.versionOverrides, versionId);
    if (versionOverrides) {
      config = deepMerge(config, versionOverrides);
    }
  }

  return config;
}

/**
 * Get images node config specifically.
 * Convenience function for the common case.
 */
export function getImagesConfig(
  configs: WorkflowConfigs,
  workflowKey: string,
  ecosystemKey: string,
  versionId?: number
): ImagesNodeConfig | undefined {
  const config = getNodeConfig(configs, workflowKey, ecosystemKey, versionId);
  return config.images;
}
