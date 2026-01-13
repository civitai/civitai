/**
 * Generation Features Configuration
 *
 * Features are derived from workflows defined in basemodel.constants.ts.
 * This module provides helpers for the feature-first UI architecture.
 */

import {
  ecosystems,
  workflows,
  workflowByKey,
  supportsWorkflow,
  type WorkflowRecord,
} from '~/shared/constants/basemodel.constants';

// =============================================================================
// Types
// =============================================================================

export type FeatureCategory =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'video-enhancements'
  | 'image-processing';

export type FeatureRecord = {
  /** Workflow key (used as feature ID) */
  id: string;
  /** Display label */
  label: string;
  /** Category for grouping in UI */
  category: FeatureCategory;
  /** Input type required */
  inputType: 'text' | 'image' | 'video';
  /** If true, this feature is ecosystem-specific */
  ecosystemSpecific?: boolean;
};

// =============================================================================
// Feature Definitions
// =============================================================================

/**
 * Convert a workflow record to a feature record.
 */
function workflowToFeature(workflow: WorkflowRecord): FeatureRecord {
  // Determine category based on input type and output type
  const outputType = workflow.outputType ?? 'image';
  let category: FeatureCategory;

  if (workflow.inputType === 'video') {
    // Video input workflows are video enhancements
    category = 'video-enhancements';
  } else if (outputType === 'video') {
    category = workflow.inputType === 'text' ? 'text-to-video' : 'image-to-video';
  } else {
    category = workflow.inputType === 'text' ? 'text-to-image' : 'image-to-image';
  }

  return {
    id: workflow.key,
    label: workflow.label,
    category,
    inputType: workflow.inputType,
    ecosystemSpecific: workflow.ecosystemIds.length === 1,
  };
}

/**
 * All features derived from workflows.
 * Order is preserved from the workflows array in basemodelv2.constants.ts.
 */
export const features: FeatureRecord[] = workflows.map(workflowToFeature);

/** Lookup map for features by ID (workflow key) */
export const featureById = new Map(features.map((f) => [f.id, f]));

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a feature (workflow) is available for an ecosystem.
 */
export function isFeatureAvailable(featureId: string, ecosystemId: number): boolean {
  return supportsWorkflow(ecosystemId, featureId);
}

/**
 * Get features available for a specific ecosystem.
 */
export function getFeaturesForEcosystem(ecosystemId: number): FeatureRecord[] {
  return features.filter((f) => isFeatureAvailable(f.id, ecosystemId));
}

/**
 * Get all features grouped by category with compatibility info for an ecosystem.
 */
export function getFeaturesWithCompatibility(ecosystemId: number): {
  category: FeatureCategory;
  label: string;
  features: (FeatureRecord & { compatible: boolean })[];
}[] {
  const categories: { category: FeatureCategory; label: string }[] = [
    { category: 'text-to-image', label: 'Text to Image' },
    { category: 'image-to-image', label: 'Image to Image' },
    { category: 'text-to-video', label: 'Text to Video' },
    { category: 'image-to-video', label: 'Image to Video' },
    { category: 'video-enhancements', label: 'Enhancements' },
  ];

  return categories.map(({ category, label }) => ({
    category,
    label,
    features: features
      .filter((f) => f.category === category)
      .map((f) => ({ ...f, compatible: isFeatureAvailable(f.id, ecosystemId) })),
  }));
}

/**
 * Get all features grouped by category (without compatibility info).
 * Used when all features should be shown regardless of ecosystem.
 */
export function getAllFeaturesGrouped(): {
  category: FeatureCategory;
  label: string;
  features: (FeatureRecord & { compatible: boolean })[];
}[] {
  const categories: { category: FeatureCategory; label: string }[] = [
    { category: 'text-to-image', label: 'Text to Image' },
    { category: 'image-to-image', label: 'Image to Image' },
    { category: 'text-to-video', label: 'Text to Video' },
    { category: 'image-to-video', label: 'Image to Video' },
    { category: 'video-enhancements', label: 'Enhancements' },
  ];

  return categories.map(({ category, label }) => ({
    category,
    label,
    features: features
      .filter((f) => f.category === category)
      .map((f) => ({ ...f, compatible: true })), // All features are "compatible" when not filtering
  }));
}

/**
 * Get the first compatible ecosystem for a feature.
 */
export function getDefaultEcosystemForFeature(featureId: string): number | undefined {
  const workflow = workflowByKey.get(featureId);
  if (!workflow) return undefined;

  // For specific workflows, return the first ecosystem
  if (workflow.ecosystemIds.length > 0) {
    return workflow.ecosystemIds[0];
  }

  // For universal workflows, find first compatible ecosystem
  for (const eco of ecosystems) {
    if (supportsWorkflow(eco.id, featureId)) {
      return eco.id;
    }
  }

  return undefined;
}

/**
 * Get all ecosystems that support a specific feature.
 */
export function getEcosystemsForFeature(featureId: string): number[] {
  return ecosystems.filter((e) => supportsWorkflow(e.id, featureId)).map((e) => e.id);
}

/**
 * Derive input type from feature.
 */
export function getInputTypeForFeature(featureId: string): 'text' | 'image' | 'video' {
  const workflow = workflowByKey.get(featureId);
  return workflow?.inputType ?? 'text';
}

/**
 * Derive output type from feature.
 */
export function getOutputTypeForFeature(featureId: string): 'image' | 'video' {
  const workflow = workflowByKey.get(featureId);
  return workflow?.outputType ?? 'image';
}

/**
 * Get the workflow key for a feature.
 * Since features are now directly mapped to workflows, this just returns the feature ID.
 */
export function getWorkflowForFeature(featureId: string): string {
  return featureId;
}
