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
  workflowOptions,
  type WorkflowOption,
  type WorkflowCategory,
  getEcosystemsForWorkflow,
  bulkWorkflowLimits,
} from '~/shared/data-graph/generation/config/workflows';
import {
  getWorkflowsForMediaType,
  workflowHasNode,
} from '~/shared/data-graph/generation/generation-graph';
import {
  openCompatibilityConfirmModal,
  buildWorkflowPendingChange,
} from '~/components/generation_v2/CompatibilityConfirmModal';
import { generationGraphPanel, generationGraphStore } from '~/store/generation-graph.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import { sourceMetadataStore, type SourceMetadata } from '~/store/source-metadata.store';
import { useLegacyGeneratorStore } from '~/store/legacy-generator.store';
import { UpscaleImageModal } from '~/components/Orchestrator/components/UpscaleImageModal';
import { BackgroundRemovalModal } from '~/components/Orchestrator/components/BackgroundRemovalModal';
import { VideoInterpolationModal } from '~/components/Orchestrator/components/VideoInterpolationModal';
import { UpscaleVideoModal } from '~/components/Orchestrator/components/UpscaleVideoModal';
import { getImageDimensions, getSourceImageFromUrl } from '~/utils/image-utils';

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
  /**
   * How to filter workflows:
   * - 'input' (default): workflows that accept this media type as input (for generated item actions)
   * - 'output': all workflows that produce this media type (for remix/workflow selection)
   */
  filterBy?: 'input' | 'output';
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
  filterBy = 'input',
}: UseGeneratedItemWorkflowsOptions): UseGeneratedItemWorkflowsReturn {
  return useMemo(() => {
    const ecosystemId = ecosystemKey ? ecosystemByKey.get(ecosystemKey)?.id : undefined;

    // Get workflows based on filter mode:
    // - 'input': workflows that accept this media type as input (for generated item actions)
    // - 'output': all workflows that produce this media type (for remix/workflow selection)
    const availableWorkflows =
      filterBy === 'input'
        ? getWorkflowsForMediaType(outputType)
        : workflowOptions.filter((w) => w.category === outputType);

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
  }, [outputType, ecosystemKey, filterBy]);
}

// =============================================================================
// Apply Workflow Utilities
// =============================================================================

/**
 * Resolve image dimensions for a BlobData item.
 * Priority: sourceMetadataStore cache (set by input component) → BlobData dims → fetch from URL.
 */
async function resolveImageDimensions(image: BlobData): Promise<{ width: number; height: number }> {
  const stored = sourceMetadataStore.getMetadata(image.url);
  if (stored?.width && stored?.height) return { width: stored.width, height: stored.height };
  return getImageDimensions(image.url).catch(() => ({ width: 512, height: 512 }));
}

interface ApplyWorkflowOptions {
  workflowId: string;
  image: BlobData;
}

/** Check if workflow switches media type (e.g., img2vid) */
function isCrossMediaWorkflow(image: BlobData, workflowId: string): boolean {
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
 * Append an image to the upscale batch.
 * Always uses 'append' runType so the form merges with existing images.
 * Stores source metadata for enhancement tracking.
 */
async function appendUpscaleImage(image: BlobData) {
  generationGraphPanel.setViewWithReturn('generate');

  const dims = await resolveImageDimensions(image);

  // Store source metadata for enhancement tracking
  if (image.params || image.resources) {
    sourceMetadataStore.setMetadata(image.url, {
      params: image.params,
      resources: image.resources,
      ...(image.remixOfId != null ? { remixOfId: image.remixOfId } : {}),
    });
  }

  generationGraphStore.setData({
    params: {
      workflow: 'img2img:upscale',
      images: [{ url: image.url, width: dims.width, height: dims.height }],
    },
    resources: [],
    runType: 'append',
  });
}

/**
 * Send generated output data to the generation form for a specific workflow.
 */
async function applyWorkflowToForm({
  workflowId,
  image,
  ecosystem,
  clearResources,
}: ApplyWorkflowOptions & { ecosystem?: string; clearResources: boolean }) {
  dialogStore.closeById('generated-image');

  const config = workflowConfigByKey.get(workflowId);
  const isEnhancement = config?.enhancement === true;

  // For enhancement workflows, save current view so we can return to it after submit
  if (isEnhancement) {
    generationGraphPanel.setViewWithReturn('generate');
  } else {
    generationGraphPanel.setView('generate');
  }

  const inputType = getInputTypeForWorkflow(workflowId);

  // Build images in graph format { url, width, height }[]
  // Pass image for workflows that require it (inputType: 'image') OR
  // for text-input workflows whose graph has an 'images' node
  const isImageType = image.type !== 'video';
  const acceptsImages =
    inputType === 'image' || (isImageType && workflowHasNode(workflowId, 'images'));

  let images: { url: string; width: number; height: number }[] | undefined;
  if (acceptsImages) {
    const dims = await resolveImageDimensions(image);
    images = [{ url: image.url, width: dims.width, height: dims.height }];
  }

  if (isEnhancement && (image.params || image.resources)) {
    // Store original generation data as source metadata
    sourceMetadataStore.setMetadata(image.url, {
      params: image.params,
      resources: image.resources,
      ...(image.remixOfId != null ? { remixOfId: image.remixOfId } : {}),
    });
  }

  generationGraphStore.setData({
    params: {
      workflow: workflowId,
      prompt: image.params?.prompt,
      negativePrompt: image.params?.negativePrompt,
      ...(images ? { images } : {}),
      ...(inputType === 'video' ? { video: image.url } : {}),
      ...(ecosystem ? { ecosystem } : {}),
    },
    resources: clearResources ? [] : image.resources ?? [],
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
 * metadata.params/resources are always the original generation (resolved).
 */
function getSourceMetadataFromImage(
  image: BlobData
): Omit<SourceMetadata, 'extractedAt'> | undefined {
  if (!image.params && !image.resources) return undefined;
  return { params: image.params, resources: image.resources };
}

/**
 * Open the appropriate modal for an enhancement workflow.
 * Returns true if a modal was opened, false otherwise.
 */
async function openEnhancementModal(workflowId: string, image: BlobData): Promise<boolean> {
  const metadata = getSourceMetadataFromImage(image);

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
 * Apply a workflow to the form with ecosystem selection.
 * For non-enhancement workflows, always shows an ecosystem selection modal
 * so the user can choose which ecosystem to use. Incompatible ecosystems
 * show a warning message; compatible ones just show the picker.
 * For legacy generator users, opens dedicated modals for enhancement workflows.
 */
export async function applyWorkflowWithCheck({
  workflowId: rawWorkflowId,
  image,
  compatible,
  isLightbox,
}: ApplyWorkflowOptions & { compatible: boolean; isLightbox?: boolean }) {
  const ecosystemKey = image.ecosystemKey;
  // Resolve alias option IDs (e.g., 'img2vid#0') to the actual graph key ('img2vid')
  const option = workflowOptionById.get(rawWorkflowId);
  const workflowId = option?.graphKey ?? rawWorkflowId;
  // For aliases, capture their specific ecosystem constraint (e.g., First/Last Frame → Vidu only)
  const isAlias = option && option.id !== option.graphKey;
  const aliasEcosystemIds = isAlias ? option.ecosystemIds : undefined;

  // For legacy generator users, check if we should open a modal instead
  if (shouldOpenModal(workflowId)) {
    const modalOpened = await openEnhancementModal(workflowId, image);
    if (modalOpened) return;
  }

  // Close the lightbox if we're in the lightbox context (enhancement modals stay on top)
  if (isLightbox) dialogStore.closeById('generated-image');

  const isCrossMedia = isCrossMediaWorkflow(image, workflowId);
  const config = workflowConfigByKey.get(workflowId);
  const isStandalone = (config?.ecosystemIds.length ?? 0) === 0;
  const isEnhancement = config?.enhancement === true;

  // Enhancement and standalone workflows: apply directly (no ecosystem choice needed)
  if (isEnhancement || isStandalone) {
    // Upscale always appends images to build a batch
    if (workflowId === 'img2img:upscale') {
      await appendUpscaleImage(image);
      return;
    }

    await applyWorkflowToForm({
      workflowId,
      image,
      ecosystem: getTargetEcosystemKey(workflowId, ecosystemKey, isCrossMedia, aliasEcosystemIds),
      clearResources: isStandalone || isCrossMedia,
    });
    return;
  }

  // If the generated image's ecosystem is already compatible, skip the modal
  // and treat it like a remix — send all original params/resources with the
  // workflow overridden so the form is fully populated from the generated image.
  if (compatible && ecosystemKey) {
    dialogStore.closeById('generated-image');
    generationGraphPanel.setView('generate');

    const inputType = getInputTypeForWorkflow(workflowId);
    const isImageType = image.type !== 'video';
    const acceptsImages =
      inputType === 'image' || (isImageType && workflowHasNode(workflowId, 'images'));

    let images: { url: string; width: number; height: number }[] | undefined;
    if (acceptsImages) {
      const dims = await resolveImageDimensions(image);
      images = [{ url: image.url, width: dims.width, height: dims.height }];
    }

    generationGraphStore.setData({
      params: {
        ...image.params,
        workflow: workflowId,
        seed: undefined,
        ...(images ? { images } : {}),
        ...(inputType === 'video' ? { video: image.url } : {}),
      },
      resources: image.resources,
      runType: 'replay',
    });
    return;
  }

  // Incompatible ecosystem: show ecosystem selection modal
  // Determine default ecosystem key — prefer stored preference, then first valid
  const storedPref = workflowPreferences.getPreferredEcosystem(workflowId);
  const storedEco = storedPref ? ecosystemByKey.get(storedPref) : undefined;
  const defaultTarget = storedEco
    ? { key: storedEco.key }
    : getValidEcosystemForWorkflow(workflowId, ecosystemKey);

  const pendingChange = {
    ...buildWorkflowPendingChange({
      workflowId,
      currentEcosystem: ecosystemKey ?? '',
      optionId: rawWorkflowId,
      defaultEcosystemKey: defaultTarget?.key,
    }),
    incompatible: !compatible,
  };

  openCompatibilityConfirmModal({
    pendingChange,
    onConfirm: (selectedEcosystemKey) => {
      const targetEco = selectedEcosystemKey ?? pendingChange.defaultEcosystemKey;
      const ecosystemChanged = targetEco !== ecosystemKey;
      applyWorkflowToForm({
        workflowId,
        image,
        ecosystem: targetEco,
        clearResources: isCrossMedia || ecosystemChanged,
      });
    },
  });
}

// =============================================================================
// Bulk Workflow Actions
// =============================================================================

/**
 * Apply a workflow to multiple images at once.
 * Slices to the workflow's max batch size, stores source metadata for each,
 * verifies dimensions in parallel, and sends to the generation form.
 */
export async function applyBulkWorkflow(workflowId: string, images: BlobData[]) {
  const max = bulkWorkflowLimits[workflowId];
  if (!max) return;

  const batch = images.slice(0, max);

  generationGraphPanel.setViewWithReturn('generate');

  // Store source metadata for each image
  for (const image of batch) {
    if (image.params || image.resources) {
      sourceMetadataStore.setMetadata(image.url, {
        params: image.params,
        resources: image.resources,
        ...(image.remixOfId != null ? { remixOfId: image.remixOfId } : {}),
      });
    }
  }

  // Resolve dimensions for all images in parallel (uses store cache, then BlobData, then fetch)
  const imagesWithDims = await Promise.all(
    batch.map(async (img) => {
      const dims = await resolveImageDimensions(img);
      return { url: img.url, width: dims.width, height: dims.height };
    })
  );

  generationGraphStore.setData({
    params: { workflow: workflowId, images: imagesWithDims },
    resources: [],
    runType: 'append',
  });
}
