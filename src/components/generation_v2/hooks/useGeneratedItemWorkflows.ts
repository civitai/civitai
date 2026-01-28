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
import { generationStore } from '~/store/generation.store';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { getSourceImageFromUrl } from '~/utils/image-utils';
import type {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';

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

/**
 * Send generated output data to the generation form for a specific workflow.
 */
async function applyWorkflowToForm({ workflowId, image, step }: ApplyWorkflowOptions) {
  // Close lightbox if open
  dialogStore.closeById('generated-image');

  const outputType = getOutputTypeForWorkflow(workflowId);
  const inputType = getInputTypeForWorkflow(workflowId);
  const isStandalone = (workflowConfigByKey.get(workflowId)?.ecosystemIds.length ?? 0) === 0;

  const sourceImage =
    inputType === 'image' ? await getSourceImageFromUrl({ url: image.url }) : undefined;

  generationStore.setData({
    type: outputType === 'video' ? 'video' : 'image',
    workflow: workflowId,
    params: {
      prompt: (step.params as Record<string, unknown>).prompt,
      negativePrompt: (step.params as Record<string, unknown>).negativePrompt,
      ...(sourceImage ? { images: [sourceImage] } : {}),
      ...(inputType === 'video' ? { video: image.url } : {}),
    },
    resources: isStandalone ? [] : (step.resources as any),
    runType: 'patch',
  });
}

/**
 * Apply a workflow to the form with a compatibility check.
 * If the workflow is incompatible with the output's ecosystem, shows a
 * confirmation modal before proceeding.
 */
export function applyWorkflowWithCheck({
  workflowId,
  ecosystemKey,
  image,
  step,
  compatible,
}: ApplyWorkflowOptions & { ecosystemKey?: string; compatible: boolean }) {
  if (!compatible) {
    const target = getValidEcosystemForWorkflow(workflowId, ecosystemKey);
    if (target && ecosystemKey) {
      openCompatibilityConfirmModal({
        pendingChange: {
          type: 'workflow',
          value: workflowId,
          workflowLabel: workflowConfigByKey.get(workflowId)?.label ?? workflowId,
          currentEcosystem: ecosystemKey,
          targetEcosystem: target.displayName,
        },
        onConfirm: () => applyWorkflowToForm({ workflowId, image, step }),
      });
      return;
    }
  }
  applyWorkflowToForm({ workflowId, image, step });
}
