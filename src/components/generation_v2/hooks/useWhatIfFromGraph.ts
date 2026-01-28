/**
 * useWhatIfFromGraph
 *
 * Hook that fetches cost estimation (what-if) data for the generation graph.
 * Debounces the request and only fetches when the user is logged in.
 *
 * Cost estimation uses a lighter validity check than form submission:
 * it only requires cost-affecting fields (workflow, baseModel, model, etc.)
 * and lets the backend fill in placeholders for non-cost-affecting fields
 * (prompt, source images) via applyWhatIfDefaults.
 */

import { useDebouncedValue } from '@mantine/hooks';
import { isEqual, omit } from 'lodash-es';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import { trpc } from '~/utils/trpc';

// =============================================================================
// Constants
// =============================================================================

/**
 * Graph keys that don't affect cost estimation.
 * Changes to these fields will NOT trigger a new whatIf query.
 * Add additional keys here as needed.
 */
const IGNORED_KEYS_FOR_WHATIF = ['prompt', 'negativePrompt', 'seed', 'denoise'] as const;

// =============================================================================
// Types
// =============================================================================

export interface UseWhatIfFromGraphOptions {
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

// =============================================================================
// Hook
// =============================================================================

export function useWhatIfFromGraph({ enabled = true }: UseWhatIfFromGraphOptions = {}) {
  const graph = useGraph<GenerationGraphTypes>();
  const currentUser = useCurrentUser();

  // Track graph changes with a monotonic revision counter.
  // This avoids relying on getSnapshot() returning a new object reference,
  // which is unreliable across reset+set cycles (e.g. remix).
  // We filter out non-cost-affecting fields to avoid unnecessary queries.
  const [revision, incrementRevision] = useReducer((r: number) => r + 1, 0);
  const prevSnapshotRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    return graph.subscribe(() => {
      const snapshot = graph.getSnapshot() as Record<string, unknown>;
      const relevantSnapshot = omit(snapshot, IGNORED_KEYS_FOR_WHATIF);

      // Only increment revision if cost-affecting values changed
      if (!isEqual(relevantSnapshot, prevSnapshotRef.current)) {
        prevSnapshotRef.current = relevantSnapshot;
        incrementRevision();
      }
    });
  }, [graph]);

  // Debounce the revision counter to avoid excessive API calls and validation runs
  const [debouncedRevision] = useDebouncedValue(revision, 150);

  // Read the snapshot when the debounced revision changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedValues = useMemo(() => graph.getSnapshot(), [debouncedRevision, graph]);

  // Full validation for isValid flag (used to disable submit button)
  // Only run validation on debounced values to avoid running on every keystroke
  const validationResult = useMemo(
    () => (debouncedValues ? graph.validate({ saveState: false }) : null),
    [debouncedValues, graph]
  );
  const isValid = validationResult?.success ?? false;

  // Lighter check for cost estimation: only require cost-affecting fields.
  // The backend fills in placeholders for non-cost-affecting fields (prompt, images)
  // via applyWhatIfDefaults, so we don't need full validation to pass.
  const canEstimateCost = useMemo(() => {
    if (!debouncedValues) return false;
    const snapshot = debouncedValues as Record<string, unknown>;

    const workflow = snapshot.workflow as string | undefined;
    if (!workflow) return false;

    const config = workflowConfigByKey.get(workflow);
    if (!config) return false;

    // Standalone workflows (upscale, remove-bg, vid2vid) need actual source media
    // for cost calculation (dimensions affect scale factor), so require full validation
    if (config.ecosystemIds.length === 0) return isValid;

    // Ecosystem workflows need baseModel to determine pricing
    if (!snapshot.baseModel) return false;

    return true;
  }, [debouncedValues, isValid]);

  // Build the query payload using the lighter cost check
  const queryPayload = useMemo(() => {
    if (!debouncedValues || !canEstimateCost) return null;
    return debouncedValues;
  }, [debouncedValues, canEstimateCost]);

  const queryResult = trpc.orchestrator.whatIfFromGraph.useQuery(queryPayload as any, {
    enabled: enabled && !!currentUser && !!queryPayload,
  });

  return {
    ...queryResult,
    isValid,
    validationErrors: validationResult?.success === false ? validationResult.errors : undefined,
  };
}
