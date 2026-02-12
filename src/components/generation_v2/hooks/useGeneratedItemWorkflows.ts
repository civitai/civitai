/**
 * useGeneratedItemWorkflows
 *
 * Hook and utilities for determining available workflow actions
 * for a generated output (image or video) and applying them
 * with compatibility checks.
 */

import { useMemo } from 'react';
import { ecosystemById, ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  getOutputTypeForWorkflow,
  getInputTypeForWorkflow,
  getValidEcosystemForWorkflow,
  isWorkflowAvailable,
  workflowConfigByKey,
  workflowOptionById,
  type WorkflowOption,
  type WorkflowCategory,
  getEcosystemsForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import {
  getWorkflowsForMediaType,
  workflowHasNode,
} from '~/shared/data-graph/generation/generation-graph';
import { openCompatibilityConfirmModal } from '~/components/generation_v2/CompatibilityConfirmModal';
import { generationGraphPanel, generationGraphStore } from '~/store/generation-graph.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import type { GenerationResource } from '~/shared/types/generation.types';
import { sourceMetadataStore, type SourceMetadata } from '~/store/source-metadata.store';
import { useLegacyGeneratorStore } from '~/store/legacy-generator.store';
import { UpscaleImageModal } from '~/components/Orchestrator/components/UpscaleImageModal';
import { BackgroundRemovalModal } from '~/components/Orchestrator/components/BackgroundRemovalModal';
import { VideoInterpolationModal } from '~/components/Orchestrator/components/VideoInterpolationModal';
import { UpscaleVideoModal } from '~/components/Orchestrator/components/UpscaleVideoModal';
import { getSourceImageFromUrl } from '~/utils/image-utils';

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
  image: 'Image',
  video: 'Video',
};

/** Categories relevant for image outputs (workflows that accept image input) */
const imageCategoryOrder: WorkflowCategory[] = ['image', 'video'];

/** Categories relevant for video outputs (workflows that accept video input) */
const videoCategoryOrder: WorkflowCategory[] = ['video'];

// =============================================================================
// Hook
// =============================================================================

export function useGeneratedItemWorkflows({
  outputType,
  ecosystemKey,
}: UseGeneratedItemWorkflowsOptions): UseGeneratedItemWorkflowsReturn {
  return useMemo(() => {
    const ecosystemId = ecosystemKey ? ecosystemByKey.get(ecosystemKey)?.id : undefined;

    // Get all workflows that accept this output type as input (derived from graph structure)
    const availableWorkflows = getWorkflowsForMediaType(outputType);

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
 * - Cross-media with alias constraint: force an ecosystem from the alias's ecosystemIds
 * - Cross-media with single-ecosystem workflow: force that ecosystem (e.g., ref2vid → Vidu)
 * - Cross-media with broad support: let the graph keep its current ecosystem (effect validates)
 * - Same-media: use image's ecosystem, falling back to stored preference
 */
function getTargetEcosystemKey(
  workflowId: string,
  ecosystemKey: string | undefined,
  isCrossMedia: boolean,
  aliasEcosystemIds?: number[]
): string | undefined {
  if (isCrossMedia) {
    // Alias-specific workflows (e.g., "First/Last Frame" → Vidu only) need a forced ecosystem
    if (aliasEcosystemIds && aliasEcosystemIds.length > 0) {
      return ecosystemById.get(aliasEcosystemIds[0])?.key;
    }
    // Single-ecosystem workflows (e.g., ref2vid → Vidu only) must force
    // the ecosystem so the legacy form gets the correct engine
    const workflowEcosystems = getEcosystemsForWorkflow(workflowId);
    if (workflowEcosystems.length === 1) {
      return ecosystemById.get(workflowEcosystems[0])?.key;
    }
    // Broad cross-media: let the graph keep its current ecosystem
    return undefined;
  }
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
  generationGraphPanel.setView('generate');

  const inputType = getInputTypeForWorkflow(workflowId);
  const stepParams = step.params;
  const config = workflowConfigByKey.get(workflowId);

  // Build images in graph format { url, width, height }[]
  // Pass image for workflows that require it (inputType: 'image') OR
  // for text-input workflows whose graph has an 'images' node
  const isImageType = image.type !== 'video';
  const acceptsImages =
    inputType === 'image' || (isImageType && workflowHasNode(workflowId, 'images'));
  const images = acceptsImages
    ? [{ url: image.url, width: image.width, height: image.height }]
    : undefined;

  // For enhancement workflows, store the original metadata
  const isEnhancement = config?.enhancement === true;

  if (isEnhancement && step.metadata) {
    // Store source metadata keyed by the image/video URL
    // Include transformations if this image has already been enhanced
    sourceMetadataStore.setMetadata(image.url, {
      params: step.metadata.params,
      resources: step.metadata.resources,
      transformations: (step.metadata as any).transformations,
    });
  }

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

// =============================================================================
// Modal Handlers for Legacy Generator
// =============================================================================

/** Workflows that have dedicated modals for legacy generator users */
const MODAL_WORKFLOWS = [
  'img2img:upscale',
  'img2img:remove-background',
  'vid2vid:interpolate',
  'vid2vid:upscale',
];

/**
 * Check if a workflow should open a modal for legacy generator users.
 */
function shouldOpenModal(workflowId: string): boolean {
  const useLegacy = useLegacyGeneratorStore.getState().useLegacy;
  return useLegacy && MODAL_WORKFLOWS.includes(workflowId);
}

/**
 * Get source metadata for an image/video from the step.
 */
function getSourceMetadataFromStep(
  step: Omit<NormalizedGeneratedImageStep, 'images'>
): Omit<SourceMetadata, 'extractedAt'> | undefined {
  if (!step.metadata) return undefined;
  return {
    params: step.metadata.params,
    resources: step.metadata.resources,
    transformations: (step.metadata as any).transformations,
  };
}

/**
 * Open the appropriate modal for an enhancement workflow.
 * Returns true if a modal was opened, false otherwise.
 */
async function openEnhancementModal(
  workflowId: string,
  image: NormalizedGeneratedImage,
  step: Omit<NormalizedGeneratedImageStep, 'images'>
): Promise<boolean> {
  const metadata = getSourceMetadataFromStep(step);

  switch (workflowId) {
    case 'img2img:upscale': {
      const sourceImage = await getSourceImageFromUrl({ url: image.url, upscale: true });
      dialogStore.trigger({
        component: UpscaleImageModal,
        props: { sourceImage, metadata },
      });
      return true;
    }

    case 'img2img:remove-background': {
      const sourceImage = await getSourceImageFromUrl({ url: image.url });
      dialogStore.trigger({
        component: BackgroundRemovalModal,
        props: { sourceImage, metadata },
      });
      return true;
    }

    case 'vid2vid:interpolate': {
      dialogStore.trigger({
        component: VideoInterpolationModal,
        props: { videoUrl: image.url, metadata },
      });
      return true;
    }

    case 'vid2vid:upscale': {
      dialogStore.trigger({
        component: UpscaleVideoModal,
        props: { videoUrl: image.url, metadata },
      });
      return true;
    }

    default:
      return false;
  }
}

/**
 * Apply a workflow to the form with a compatibility check.
 * Shows confirmation modal for incompatible workflows before proceeding.
 * For legacy generator users, opens dedicated modals for enhancement workflows.
 */
export async function applyWorkflowWithCheck({
  workflowId: rawWorkflowId,
  ecosystemKey,
  image,
  step,
  compatible,
}: ApplyWorkflowOptions & { ecosystemKey?: string; compatible: boolean }) {
  // Resolve alias option IDs (e.g., 'img2vid#0') to the actual graph key ('img2vid')
  const option = workflowOptionById.get(rawWorkflowId);
  const workflowId = option?.graphKey ?? rawWorkflowId;
  // For aliases, capture their specific ecosystem constraint (e.g., First/Last Frame → Vidu only)
  const isAlias = option && option.id !== option.graphKey;
  const aliasEcosystemIds = isAlias ? option.ecosystemIds : undefined;

  // For legacy generator users, check if we should open a modal instead
  if (shouldOpenModal(workflowId)) {
    const modalOpened = await openEnhancementModal(workflowId, image, step);
    if (modalOpened) return;
  }

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
      const compatibleIds = getEcosystemsForWorkflow(workflowId);
      openCompatibilityConfirmModal({
        pendingChange: {
          type: 'workflow',
          value: workflowId,
          optionId: workflowId,
          currentEcosystem: ecosystemKey,
          compatibleEcosystemIds: compatibleIds,
          defaultEcosystemKey: target.key,
        },
        onConfirm: (selectedEcosystemKey) =>
          applyWorkflowToForm({
            workflowId,
            image,
            step,
            ecosystem: selectedEcosystemKey ?? target.key,
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
    ecosystem: getTargetEcosystemKey(workflowId, ecosystemKey, isCrossMedia, aliasEcosystemIds),
    clearResources,
  });
}
