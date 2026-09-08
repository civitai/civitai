import { useMemo } from 'react';

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  filterWorkflowsByFeatureFlags,
  filterWorkflowsByGatedEcosystems,
  getAllWorkflowsGrouped,
} from '~/shared/data-graph/generation/config/workflows';
import {
  mergeGateStates,
  rulesToStates,
  type GateItemState,
} from '~/shared/data-graph/generation/gates';

/**
 * Who may see which workflow — the single answer for both pickers.
 *
 * `WorkflowInput` (data-graph lane) and `WorkflowPicker` (form-graph lane) are
 * live at the same time and both have to decide this. Keeping a copy each meant
 * a gate rule or a feature flag could be honoured in one lane and ignored in
 * the other, which is exactly what the server-side resolver exists to prevent.
 */

/**
 * Workflows grouped by output category, with the two list-level filters
 * applied: options whose backing ecosystems are ALL hidden by a gate rule, and
 * options behind a feature flag this user does not have.
 */
export function useAvailableWorkflowGroups() {
  const { gateRules } = useGenerationConfig();
  const features = useFeatureFlags();

  return useMemo(() => {
    const hiddenEcosystems = new Set<string>();
    for (const [key, rule] of rulesToStates(gateRules).ecosystems)
      if (rule.state === 'hidden') hiddenEcosystems.add(key);

    return filterWorkflowsByFeatureFlags(
      filterWorkflowsByGatedEcosystems(getAllWorkflowsGrouped(), hiddenEcosystems),
      features as unknown as Record<string, boolean | undefined>
    );
  }, [gateRules, features]);
}

/**
 * Per-workflow gate state, keyed by graphKey. Mirrors the workflow node's
 * resolver so client and server agree: `hidden` keys drop out of the list
 * entirely, the rest carry a state a row renders as a badge or an upsell.
 */
export function useWorkflowGateStates() {
  const { gateRules } = useGenerationConfig();

  return useMemo(() => {
    const { hidden, states } = mergeGateStates(undefined, rulesToStates(gateRules).workflows);
    return {
      hiddenSet: new Set(hidden),
      stateMap: new Map<string, GateItemState>(states.map((s) => [s.key, s])),
    };
  }, [gateRules]);
}
