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
import { workflowPreferences } from '~/store/workflow-preferences.store';
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

/**
 * Send generated output data to the generation form for a specific workflow.
 */
async function applyWorkflowToForm({
  workflowId,
  image,
  step,
  targetEcosystemKey,
  isIncompatible,
}: ApplyWorkflowOptions & { targetEcosystemKey?: string; isIncompatible?: boolean }) {
  // Close lightbox if open
  dialogStore.closeById('generated-image');

  const outputType = getOutputTypeForWorkflow(workflowId);
  const inputType = getInputTypeForWorkflow(workflowId);
  const isStandalone = (workflowConfigByKey.get(workflowId)?.ecosystemIds.length ?? 0) === 0;

  // Check if this is a cross-media workflow (output type differs from input media)
  const currentOutputType = image.type === 'video' ? 'video' : 'image';
  const isCrossMedia = currentOutputType !== outputType;

  // Determine if we need to switch ecosystems
  // This happens for cross-media workflows OR when current ecosystem is incompatible
  const needsEcosystemSwitch = isCrossMedia || isIncompatible;

  // Always use explicit target if provided (ensures stored preference is respected)
  // For ecosystem switches without explicit target, fall back to stored preference
  const baseModel =
    targetEcosystemKey ??
    (needsEcosystemSwitch ? workflowPreferences.getPreferredEcosystem(workflowId) : undefined);

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
      // Include baseModel when switching ecosystems to use stored preference
      ...(baseModel ? { baseModel } : {}),
    },
    // Don't carry over resources when switching ecosystems (different ecosystem = different resources)
    resources: isStandalone || needsEcosystemSwitch ? [] : (step.resources as any),
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
  // For incompatible workflows, show confirmation modal
  if (!compatible) {
    // First check for stored preference, then fall back to first compatible ecosystem
    const storedPreference = workflowPreferences.getPreferredEcosystem(workflowId);
    const storedEcosystem = storedPreference ? ecosystemByKey.get(storedPreference) : undefined;

    // Use stored preference if available, otherwise get first compatible
    const target = storedEcosystem
      ? {
          id: storedEcosystem.id,
          key: storedEcosystem.key,
          displayName: storedEcosystem.displayName,
        }
      : getValidEcosystemForWorkflow(workflowId, ecosystemKey);

    if (target && ecosystemKey) {
      openCompatibilityConfirmModal({
        pendingChange: {
          type: 'workflow',
          value: workflowId,
          workflowLabel: workflowConfigByKey.get(workflowId)?.label ?? workflowId,
          currentEcosystem: ecosystemKey,
          targetEcosystem: target.displayName,
        },
        onConfirm: () =>
          applyWorkflowToForm({
            workflowId,
            image,
            step,
            targetEcosystemKey: target.key,
            isIncompatible: true,
          }),
      });
      return;
    }
  }
  // Check if this is a cross-media workflow (e.g., img2vid)
  // For cross-media, the image's ecosystem is never compatible with the workflow
  const currentOutputType = image.type === 'video' ? 'video' : 'image';
  const workflowOutputType = getOutputTypeForWorkflow(workflowId);
  const isCrossMedia = currentOutputType !== workflowOutputType;

  // For cross-media workflows, use stored preference (image's ecosystem can't work)
  // For same-media compatible workflows, use image's ecosystem
  const targetEcosystem = isCrossMedia
    ? workflowPreferences.getPreferredEcosystem(workflowId)
    : ecosystemKey ?? workflowPreferences.getPreferredEcosystem(workflowId);

  applyWorkflowToForm({
    workflowId,
    image,
    step,
    targetEcosystemKey: targetEcosystem,
    isIncompatible: !compatible,
  });
}
