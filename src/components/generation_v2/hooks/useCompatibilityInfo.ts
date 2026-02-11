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
  getOutputTypeForWorkflow,
  getEcosystemsForWorkflow,
  getValidEcosystemForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import { workflowPreferences } from '~/store/workflow-preferences.store';

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
  /** Get the best compatible workflow for a target ecosystem */
  getTargetWorkflowForEcosystem: (targetEcosystemKey: string) => { id: string; label: string };
}

export interface UseCompatibilityInfoOptions {
  workflow: string | undefined;
  ecosystem: string | undefined;
}

// =============================================================================
// Hook
// =============================================================================

export function useCompatibilityInfo({
  workflow,
  ecosystem,
}: UseCompatibilityInfoOptions): CompatibilityInfo {
  return useMemo(() => {
    const currentEcosystem = ecosystem ? ecosystemByKey.get(ecosystem) : undefined;
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
      // 1. Check if current ecosystem supports the workflow
      const fromCurrent = getValidEcosystemForWorkflow(workflowId, currentEcosystemKey);
      if (fromCurrent && fromCurrent.key === currentEcosystemKey) return fromCurrent;

      // 2. Check if the user's last-used ecosystem for this workflow is still valid
      const preferred = workflowPreferences.getPreferredEcosystem(workflowId);
      if (preferred) {
        const fromPreferred = getValidEcosystemForWorkflow(workflowId, preferred);
        if (fromPreferred && fromPreferred.key === preferred) return fromPreferred;
      }

      // 3. Fall back to config default
      return fromCurrent ?? getValidEcosystemForWorkflow(workflowId);
    };

    const getTargetWorkflowForEcosystem = (targetEcosystemKey: string) => {
      const targetEcosystem = ecosystemByKey.get(targetEcosystemKey);
      const targetEcosystemId = targetEcosystem?.id;

      // Find workflows that the target ecosystem supports
      const compatibleWorkflows = workflowOptions.filter((w) => {
        const ecosystemIds = getEcosystemsForWorkflow(w.id);
        return ecosystemIds.length > 0 && targetEcosystemId !== undefined
          ? ecosystemIds.includes(targetEcosystemId)
          : false;
      });

      // Prefer a workflow of the same output type as current
      // This way txt2vid → img2vid (not txt2img) when switching to a video ecosystem
      if (currentOutputType) {
        const sameOutputType = compatibleWorkflows.find(
          (w) => getOutputTypeForWorkflow(w.id) === currentOutputType
        );
        if (sameOutputType) {
          return { id: sameOutputType.id, label: sameOutputType.label };
        }
      }

      // Fall back to the first compatible workflow, or txt2img as last resort
      const fallback = compatibleWorkflows[0] ?? workflowOptions.find((w) => w.id === 'txt2img');
      return {
        id: fallback?.id ?? 'txt2img',
        label: fallback?.label ?? 'Create Image',
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
  }, [workflow, ecosystem]);
}
