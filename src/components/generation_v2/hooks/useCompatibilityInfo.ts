/**
 * useCompatibilityInfo
 *
 * A hook that computes compatibility information between workflows and ecosystems.
 * Used to show soft indicators on incompatible options and intercept selections
 * that would trigger automatic switches.
 */

import { useMemo } from 'react';
import { ecosystemByKey, ecosystemById } from '~/shared/constants/basemodel.constants';
import {
  isWorkflowAvailable,
  workflowOptions,
  getDefaultEcosystemForWorkflow,
  getOutputTypeForWorkflow,
  getEcosystemsForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';

/**
 * Get the valid ecosystem for a workflow, considering the current value.
 * This mirrors the logic in ecosystem-graph.ts getValidEcosystemForWorkflow.
 */
function getValidEcosystemForWorkflow(
  workflowId: string,
  currentValue?: string
): { id: number; key: string; displayName: string } | undefined {
  // If current value supports the workflow, use it
  if (currentValue) {
    const ecosystem = ecosystemByKey.get(currentValue);
    if (ecosystem && isWorkflowAvailable(workflowId, ecosystem.id)) {
      return { id: ecosystem.id, key: ecosystem.key, displayName: ecosystem.displayName };
    }
  }
  // Otherwise get the default
  const defaultEcoId = getDefaultEcosystemForWorkflow(workflowId);
  if (defaultEcoId) {
    const eco = ecosystemById.get(defaultEcoId);
    if (eco) {
      return { id: eco.id, key: eco.key, displayName: eco.displayName };
    }
  }
  return undefined;
}

// =============================================================================
// Types
// =============================================================================

export interface CompatibilityInfo {
  /** Current ecosystem ID (undefined if no ecosystem selected) */
  currentEcosystemId: number | undefined;
  /** Current ecosystem key */
  currentEcosystemKey: string | undefined;
  /** Current workflow's output type */
  currentOutputType: 'image' | 'video' | undefined;
  /** Set of ecosystem keys compatible with the current workflow */
  compatibleEcosystemKeys: Set<string>;
  /** Map of workflow ID to whether it's compatible with current ecosystem */
  workflowCompatibility: Map<string, boolean>;

  /**
   * Check if a workflow is compatible with the current ecosystem.
   * Returns true if:
   * - The workflow has no ecosystem support (like img2img:upscale)
   * - The workflow changes output type (image ↔ video) - these are always allowed
   * - The current ecosystem supports the workflow
   */
  isWorkflowCompatible: (workflowId: string) => boolean;
  /** Check if an ecosystem key is compatible with the current workflow */
  isEcosystemKeyCompatible: (ecosystemKey: string) => boolean;

  /** Get the target ecosystem when selecting an incompatible workflow */
  getTargetEcosystemForWorkflow: (workflowId: string) =>
    | {
        id: number;
        key: string;
        displayName: string;
      }
    | undefined;
  /** Get the target workflow when selecting an incompatible ecosystem (always 'txt2img') */
  getTargetWorkflowForEcosystem: () => { id: string; label: string };
}

export interface UseCompatibilityInfoOptions {
  workflow: string | undefined;
  baseModel: string | undefined;
}

// =============================================================================
// Hook
// =============================================================================

export function useCompatibilityInfo({
  workflow,
  baseModel,
}: UseCompatibilityInfoOptions): CompatibilityInfo {
  return useMemo(() => {
    const currentEcosystem = baseModel ? ecosystemByKey.get(baseModel) : undefined;
    const currentEcosystemId = currentEcosystem?.id;
    const currentEcosystemKey = currentEcosystem?.key;

    // Get the current workflow's output type
    const currentOutputType = workflow ? getOutputTypeForWorkflow(workflow) : undefined;

    // Get ecosystem keys compatible with current workflow (convert IDs to keys)
    // If the current workflow has no ecosystem support, all ecosystems are considered compatible
    const workflowEcosystemIds = workflow ? getEcosystemsForWorkflow(workflow) : [];
    const workflowEcosystemKeys = workflowEcosystemIds
      .map((id) => ecosystemById.get(id)?.key)
      .filter((key): key is string => !!key);
    const currentWorkflowHasNoEcosystemSupport = workflow && workflowEcosystemKeys.length === 0;
    const compatibleEcosystemKeys = new Set<string>(workflowEcosystemKeys);

    // Build workflow compatibility map
    // Workflows with no ecosystem support (ecosystemIds: []) are always compatible
    // Workflows that change output type (image ↔ video) are always allowed without warning
    const workflowCompatibility = new Map<string, boolean>();
    for (const wf of workflowOptions) {
      // Check if this workflow has any ecosystem support at all
      const workflowEcosystems = getEcosystemsForWorkflow(wf.id);
      const hasNoEcosystemSupport = workflowEcosystems.length === 0;

      // Check if this workflow changes output type (image ↔ video)
      const targetOutputType = getOutputTypeForWorkflow(wf.id);
      const changesOutputType = currentOutputType && targetOutputType !== currentOutputType;

      workflowCompatibility.set(
        wf.id,
        hasNoEcosystemSupport ||
          changesOutputType || // Output type changes are always allowed
          currentEcosystemId === undefined ||
          isWorkflowAvailable(wf.id, currentEcosystemId)
      );
    }

    const isWorkflowCompatible = (workflowId: string): boolean => {
      return workflowCompatibility.get(workflowId) ?? true;
    };

    const isEcosystemKeyCompatible = (ecosystemKey: string): boolean => {
      // If current workflow has no ecosystem support, all ecosystems are compatible
      if (currentWorkflowHasNoEcosystemSupport) return true;
      // If no workflow selected, all ecosystems are compatible
      if (compatibleEcosystemKeys.size === 0 && !workflow) return true;
      return compatibleEcosystemKeys.has(ecosystemKey);
    };

    const getTargetEcosystemForWorkflow = (workflowId: string) => {
      // Use the same logic as ecosystem-graph: check if current baseModel supports the workflow,
      // otherwise fall back to the default ecosystem for that workflow
      return getValidEcosystemForWorkflow(workflowId, currentEcosystemKey);
    };

    const getTargetWorkflowForEcosystem = () => {
      // When switching to an incompatible ecosystem, we always fall back to txt2img
      const defaultWorkflow = workflowOptions.find((w) => w.id === 'txt2img');
      return {
        id: 'txt2img',
        label: defaultWorkflow?.label ?? 'Create Image',
      };
    };

    return {
      currentEcosystemId,
      currentEcosystemKey,
      currentOutputType,
      compatibleEcosystemKeys,
      workflowCompatibility,
      isWorkflowCompatible,
      isEcosystemKeyCompatible,
      getTargetEcosystemForWorkflow,
      getTargetWorkflowForEcosystem,
    };
  }, [workflow, baseModel]);
}
