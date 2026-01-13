/**
 * Generation Workflows Configuration
 *
 * Workflows are derived from workflow records defined in basemodel.constants.ts.
 * This module provides helpers for the workflow-first UI architecture.
 */

import {
  ecosystems,
  workflows as workflowRecords,
  workflowByKey,
  supportsWorkflow,
  type WorkflowRecord,
  type WorkflowCategory,
} from '~/shared/constants/basemodel.constants';

// Re-export for convenience
export type { WorkflowCategory };

// =============================================================================
// Types
// =============================================================================

/** @deprecated Use WorkflowCategory instead */
export type FeatureCategory = WorkflowCategory;

export type WorkflowOption = {
  /** Workflow key */
  id: string;
  /** Display label */
  label: string;
  /** Category for grouping in UI */
  category: WorkflowCategory;
  /** Input type required */
  inputType: 'text' | 'image' | 'video';
  /** If true, this workflow is ecosystem-specific */
  ecosystemSpecific?: boolean;
};

/** @deprecated Use WorkflowOption instead */
export type FeatureRecord = WorkflowOption;

// =============================================================================
// Workflow Definitions
// =============================================================================

/**
 * Convert a workflow record to a workflow option.
 */
function toWorkflowOption(workflow: WorkflowRecord): WorkflowOption {
  return {
    id: workflow.key,
    label: workflow.label,
    category: workflow.category,
    inputType: workflow.inputType,
    ecosystemSpecific: workflow.ecosystemIds.length === 1,
  };
}

/**
 * All workflow options derived from workflow records.
 * Order is preserved from the workflows array in basemodel.constants.ts.
 */
export const workflowOptions: WorkflowOption[] = workflowRecords.map(toWorkflowOption);

/** @deprecated Use workflowOptions instead */
export const features = workflowOptions;

/** Lookup map for workflows by ID (workflow key) */
export const workflowOptionById = new Map(workflowOptions.map((w) => [w.id, w]));

/** @deprecated Use workflowOptionById instead */
export const featureById = workflowOptionById;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a workflow is available for an ecosystem.
 */
export function isWorkflowAvailable(workflowId: string, ecosystemId: number): boolean {
  return supportsWorkflow(ecosystemId, workflowId);
}

/** @deprecated Use isWorkflowAvailable instead */
export const isFeatureAvailable = isWorkflowAvailable;

/**
 * Get workflows available for a specific ecosystem.
 */
export function getWorkflowsForEcosystem(ecosystemId: number): WorkflowOption[] {
  return workflowOptions.filter((w) => isWorkflowAvailable(w.id, ecosystemId));
}

/** @deprecated Use getWorkflowsForEcosystem instead */
export const getFeaturesForEcosystem = getWorkflowsForEcosystem;

/**
 * Get all workflows grouped by category with compatibility info for an ecosystem.
 */
export function getWorkflowsWithCompatibility(ecosystemId: number): {
  category: WorkflowCategory;
  label: string;
  workflows: (WorkflowOption & { compatible: boolean })[];
}[] {
  const categories: { category: WorkflowCategory; label: string }[] = [
    { category: 'text-to-image', label: 'Text to Image' },
    { category: 'image-to-image', label: 'Image to Image' },
    { category: 'image-enhancements', label: 'Enhancements' },
    { category: 'text-to-video', label: 'Text to Video' },
    { category: 'image-to-video', label: 'Image to Video' },
    { category: 'video-enhancements', label: 'Enhancements' },
  ];

  return categories.map(({ category, label }) => ({
    category,
    label,
    workflows: workflowOptions
      .filter((w) => w.category === category)
      .map((w) => ({ ...w, compatible: isWorkflowAvailable(w.id, ecosystemId) })),
  }));
}

/** @deprecated Use getWorkflowsWithCompatibility instead */
export function getFeaturesWithCompatibility(ecosystemId: number): {
  category: WorkflowCategory;
  label: string;
  features: (WorkflowOption & { compatible: boolean })[];
}[] {
  return getWorkflowsWithCompatibility(ecosystemId).map((group) => ({
    ...group,
    features: group.workflows,
  }));
}

/**
 * Get all workflows grouped by category (without compatibility info).
 * Used when all workflows should be shown regardless of ecosystem.
 */
export function getAllWorkflowsGrouped(): {
  category: WorkflowCategory;
  label: string;
  workflows: (WorkflowOption & { compatible: boolean })[];
}[] {
  const categories: { category: WorkflowCategory; label: string }[] = [
    { category: 'text-to-image', label: 'Text to Image' },
    { category: 'image-to-image', label: 'Image to Image' },
    { category: 'image-enhancements', label: 'Enhancements' },
    { category: 'text-to-video', label: 'Text to Video' },
    { category: 'image-to-video', label: 'Image to Video' },
    { category: 'video-enhancements', label: 'Enhancements' },
  ];

  return categories.map(({ category, label }) => ({
    category,
    label,
    workflows: workflowOptions
      .filter((w) => w.category === category)
      .map((w) => ({ ...w, compatible: true })),
  }));
}

/** @deprecated Use getAllWorkflowsGrouped instead */
export function getAllFeaturesGrouped(): {
  category: WorkflowCategory;
  label: string;
  features: (WorkflowOption & { compatible: boolean })[];
}[] {
  return getAllWorkflowsGrouped().map((group) => ({
    ...group,
    features: group.workflows,
  }));
}

/**
 * Get the first compatible ecosystem for a workflow.
 */
export function getDefaultEcosystemForWorkflow(workflowId: string): number | undefined {
  const workflow = workflowByKey.get(workflowId);
  if (!workflow) return undefined;

  // For specific workflows, return the first ecosystem
  if (workflow.ecosystemIds.length > 0) {
    return workflow.ecosystemIds[0];
  }

  // For universal workflows, find first compatible ecosystem
  for (const eco of ecosystems) {
    if (supportsWorkflow(eco.id, workflowId)) {
      return eco.id;
    }
  }

  return undefined;
}

/** @deprecated Use getDefaultEcosystemForWorkflow instead */
export const getDefaultEcosystemForFeature = getDefaultEcosystemForWorkflow;

/**
 * Get all ecosystems that support a specific workflow.
 */
export function getEcosystemsForWorkflow(workflowId: string): number[] {
  return ecosystems.filter((e) => supportsWorkflow(e.id, workflowId)).map((e) => e.id);
}

/** @deprecated Use getEcosystemsForWorkflow instead */
export const getEcosystemsForFeature = getEcosystemsForWorkflow;

/**
 * Derive input type from workflow.
 */
export function getInputTypeForWorkflow(workflowId: string): 'text' | 'image' | 'video' {
  const workflow = workflowByKey.get(workflowId);
  return workflow?.inputType ?? 'text';
}

/** @deprecated Use getInputTypeForWorkflow instead */
export const getInputTypeForFeature = getInputTypeForWorkflow;

/**
 * Derive output type from workflow.
 */
export function getOutputTypeForWorkflow(workflowId: string): 'image' | 'video' {
  const workflow = workflowByKey.get(workflowId);
  return workflow?.outputType ?? 'image';
}

/** @deprecated Use getOutputTypeForWorkflow instead */
export const getOutputTypeForFeature = getOutputTypeForWorkflow;

/** @deprecated No longer needed - workflows are the same as features now */
export function getWorkflowForFeature(featureId: string): string {
  return featureId;
}
