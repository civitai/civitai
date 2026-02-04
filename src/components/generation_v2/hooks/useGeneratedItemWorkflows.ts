/**
 * useGeneratedItemWorkflows
 *
 * Hook and utilities for determining available workflow actions
 * for a generated output (image or video) and applying them
 * with compatibility checks.
 */

import { useMemo } from 'react';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  getWorkflowsForOutputType,
  getOutputTypeForWorkflow,
  getInputTypeForWorkflow,
  getValidEcosystemForWorkflow,
  isWorkflowAvailable,
  workflowConfigByKey,
  type WorkflowOption,
  type WorkflowCategory,
} from '~/shared/data-graph/generation/config/workflows';
import { getEcosystemsForWorkflow } from '~/shared/data-graph/generation/config/workflows';
import { openCompatibilityConfirmModal } from '~/components/generation_v2/CompatibilityConfirmModal';
import { generationGraphStore } from '~/store/generation-graph.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import type { GenerationResource } from '~/shared/types/generation.types';

// =============================================================================
// Types
// =============================================================================

export interface GeneratedItemWorkflowGroup {
  category: WorkflowCategory;
  label: string;
  workflows: (WorkflowOption & { compatible: boolean })[];
}

export interface UseGeneratedItemWorkflowsOptions {
  /** Output type of the generated item */
  outputType: 'image' | 'video';
  /** Ecosystem key from the generated output (step.params.baseModel) */
  ecosystemKey?: string;
}

export interface UseGeneratedItemWorkflowsReturn {
  /** Workflow groups filtered to relevant categories with compatibility info */
  groups: GeneratedItemWorkflowGroup[];
  /** Check if a specific workflow is compatible with the output's ecosystem */
  isCompatible: (workflowId: string) => boolean;
}

// =============================================================================
// Category Labels
// =============================================================================

const categoryLabels: Record<WorkflowCategory, string> = {
  'text-to-image': 'Text to Image',
  'image-to-image': 'Image to Image',
  'image-enhancements': 'Enhancements',
  'text-to-video': 'Text to Video',
  'image-to-video': 'Image to Video',
  'video-enhancements': 'Video Enhancements',
};

/** Categories relevant for image outputs (workflows that accept image input) */
const imageCategoryOrder: WorkflowCategory[] = [
  'image-to-image',
  'image-enhancements',
  'image-to-video',
];

/** Categories relevant for video outputs (workflows that accept video input) */
const videoCategoryOrder: WorkflowCategory[] = ['video-enhancements'];

// =============================================================================
// Hook
// =============================================================================

export function useGeneratedItemWorkflows({
  outputType,
  ecosystemKey,
}: UseGeneratedItemWorkflowsOptions): UseGeneratedItemWorkflowsReturn {
  return useMemo(() => {
    const ecosystemId = ecosystemKey ? ecosystemByKey.get(ecosystemKey)?.id : undefined;

    // Get all workflows that accept this output type as input
    const availableWorkflows = getWorkflowsForOutputType(outputType);

    // Determine compatibility for each workflow
    const isCompatible = (workflowId: string): boolean => {
      const workflowEcosystems = getEcosystemsForWorkflow(workflowId);
      // Standalone workflows (no ecosystem requirement) are always compatible
      if (workflowEcosystems.length === 0) return true;
      // If no ecosystem info, treat as compatible
      if (ecosystemId === undefined) return true;

      // Cross-media workflows (e.g., img2vid) are always "compatible" since
      // an ecosystem switch is inherent to the workflow change
      const workflowOutputType = getOutputTypeForWorkflow(workflowId);
      if (outputType !== workflowOutputType) return true;

      return isWorkflowAvailable(workflowId, ecosystemId);
    };

    // Group workflows by category
    const categoryOrder = outputType === 'image' ? imageCategoryOrder : videoCategoryOrder;

    const groups: GeneratedItemWorkflowGroup[] = categoryOrder
      .map((category) => ({
        category,
        label: categoryLabels[category],
        workflows: availableWorkflows
          .filter((w) => w.category === category)
          .map((w) => ({ ...w, compatible: isCompatible(w.id) })),
      }))
      .filter((g) => g.workflows.length > 0);

    return { groups, isCompatible };
  }, [outputType, ecosystemKey]);
}

// =============================================================================
// Apply Workflow Utilities
// =============================================================================

interface ApplyWorkflowOptions {
  workflowId: string;
  image: NormalizedGeneratedImage;
  step: Omit<NormalizedGeneratedImageStep, 'images'>;
}

/** Check if workflow switches media type (e.g., img2vid) */
function isCrossMediaWorkflow(image: NormalizedGeneratedImage, workflowId: string): boolean {
  const currentOutputType = image.type === 'video' ? 'video' : 'image';
  return currentOutputType !== getOutputTypeForWorkflow(workflowId);
}

/**
 * Get the target ecosystem for a workflow, respecting stored preferences.
 * - Cross-media: use stored preference (image's ecosystem can't work for different media)
 * - Same-media: use image's ecosystem, falling back to stored preference
 */
function getTargetEcosystemKey(
  workflowId: string,
  ecosystemKey: string | undefined,
  isCrossMedia: boolean
): string | undefined {
  if (isCrossMedia) return workflowPreferences.getPreferredEcosystem(workflowId);
  return ecosystemKey ?? workflowPreferences.getPreferredEcosystem(workflowId);
}

/**
 * Send generated output data to the generation form for a specific workflow.
 */
function applyWorkflowToForm({
  workflowId,
  image,
  step,
  ecosystem,
  clearResources,
}: ApplyWorkflowOptions & { ecosystem?: string; clearResources: boolean }) {
  dialogStore.closeById('generated-image');

  const inputType = getInputTypeForWorkflow(workflowId);
  const stepParams = step.params;

  // Build images in graph format { url, width, height }[]
  const images =
    inputType === 'image'
      ? [{ url: image.url, width: image.width, height: image.height }]
      : undefined;

  generationGraphStore.setData({
    params: {
      workflow: workflowId,
      prompt: stepParams.prompt,
      negativePrompt: stepParams.negativePrompt,
      ...(images ? { images } : {}),
      ...(inputType === 'video' ? { video: image.url } : {}),
      ...(ecosystem ? { ecosystem } : {}),
    },
    resources: clearResources ? [] : (step.resources as GenerationResource[]),
    runType: 'patch',
  });
}

/**
 * Apply a workflow to the form with a compatibility check.
 * Shows confirmation modal for incompatible workflows before proceeding.
 */
export function applyWorkflowWithCheck({
  workflowId,
  ecosystemKey,
  image,
  step,
  compatible,
}: ApplyWorkflowOptions & { ecosystemKey?: string; compatible: boolean }) {
  const isCrossMedia = isCrossMediaWorkflow(image, workflowId);
  const isStandalone = (workflowConfigByKey.get(workflowId)?.ecosystemIds.length ?? 0) === 0;

  // Show confirmation modal for incompatible same-media workflows
  if (!compatible && ecosystemKey) {
    const storedPref = workflowPreferences.getPreferredEcosystem(workflowId);
    const storedEco = storedPref ? ecosystemByKey.get(storedPref) : undefined;
    const target = storedEco
      ? { key: storedEco.key, displayName: storedEco.displayName }
      : getValidEcosystemForWorkflow(workflowId, ecosystemKey);

    if (target) {
      openCompatibilityConfirmModal({
        pendingChange: {
          type: 'workflow',
          value: workflowId,
          currentEcosystem: ecosystemKey,
          targetEcosystem: target.displayName,
        },
        onConfirm: () =>
          applyWorkflowToForm({
            workflowId,
            image,
            step,
            ecosystem: target.key,
            clearResources: true,
          }),
      });
      return;
    }
  }

  // Clear resources when switching ecosystems (cross-media, incompatible, or standalone)
  const clearResources = isStandalone || isCrossMedia || !compatible;

  applyWorkflowToForm({
    workflowId,
    image,
    step,
    ecosystem: getTargetEcosystemKey(workflowId, ecosystemKey, isCrossMedia),
    clearResources,
  });
}
