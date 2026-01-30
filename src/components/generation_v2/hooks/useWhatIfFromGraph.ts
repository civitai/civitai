/**
 * useWhatIfFromGraph
 *
 * Hook that fetches cost estimation (what-if) data for the generation graph.
 *
 * Uses prompt focus tracking to avoid race conditions when clicking submit:
 * - When prompt is focused, we use the last committed prompt value
 * - When prompt loses focus, we update to the current value
 * - This prevents blur from triggering a new whatIf request that interferes with submit
 */

import { isEqual, omit } from 'lodash-es';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import { trpc } from '~/utils/trpc';
import { useResourceDataContext } from '../inputs/ResourceDataProvider';
import { filterSnapshotForSubmit } from '../inputs/ResourceItemContent';
import { usePromptFocusedStore } from '../inputs/PromptInput';

// =============================================================================
// Constants
// =============================================================================

/**
 * Graph keys that don't affect cost estimation at all.
 * Changes to these fields will NOT trigger a new whatIf query.
 * Note: 'prompt' IS included because it affects SFW/NSFW classification and pricing.
 */
const IGNORED_KEYS_FOR_WHATIF = ['negativePrompt', 'seed', 'denoise'] as const;

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
  const { isLoading: resourcesLoading } = useResourceDataContext();
  const promptFocused = usePromptFocusedStore((x) => x.focused);

  // Track graph changes with a revision counter
  const [revision, incrementRevision] = useReducer((r: number) => r + 1, 0);
  const prevSnapshotRef = useRef<Record<string, unknown> | null>(null);

  // Track the last committed prompt value (updated when prompt loses focus)
  const promptRef = useRef<string>('');

  useEffect(() => {
    const keysToOmit = [...IGNORED_KEYS_FOR_WHATIF, ...graph.getComputedKeys()];

    // Initialize with current snapshot
    const initialSnapshot = graph.getSnapshot() as Record<string, unknown>;
    prevSnapshotRef.current = omit(initialSnapshot, keysToOmit);
    promptRef.current = (initialSnapshot.prompt as string) ?? '';

    return graph.subscribe(() => {
      const snapshot = graph.getSnapshot() as Record<string, unknown>;
      const relevantSnapshot = omit(snapshot, keysToOmit);

      if (!isEqual(relevantSnapshot, prevSnapshotRef.current)) {
        prevSnapshotRef.current = relevantSnapshot;
        incrementRevision();
      }
    });
  }, [graph]);

  // Get current snapshot for building the query
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const snapshot = useMemo(
    () => graph.getSnapshot() as Record<string, unknown>,
    [revision, graph]
  );

  // Update committed prompt when not focused
  useEffect(() => {
    if (!promptFocused && snapshot?.prompt !== undefined) {
      promptRef.current = snapshot.prompt as string;
    }
  }, [promptFocused, snapshot?.prompt]);

  // Full validation for isValid flag (used to disable submit button)
  const validationResult = useMemo(
    () => (snapshot ? graph.validate({ saveState: false }) : null),
    [snapshot, graph]
  );
  const isValid = validationResult?.success ?? false;

  // Lighter check for cost estimation: only require cost-affecting fields.
  // The backend fills in placeholders for non-cost-affecting fields (images)
  // via applyWhatIfDefaults, so we don't need full validation to pass.
  const canEstimateCost = useMemo(() => {
    if (!snapshot) return false;

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
  }, [snapshot, isValid]);

  // Build the query payload using the lighter cost check
  // Filter out computed nodes and disabled resources
  // Use stale prompt value when prompt is focused to avoid blur race condition
  const queryPayload = useMemo(() => {
    if (!snapshot || !canEstimateCost) return null;

    // When focused, use committed prompt value to avoid race conditions with submit
    // When not focused, use current snapshot value directly (effect updates ref for next focus)
    const promptValue = promptFocused ? promptRef.current : (snapshot.prompt as string);
    const snapshotForQuery = { ...snapshot, prompt: promptValue };

    return filterSnapshotForSubmit(snapshotForQuery, {
      computedKeys: graph.getComputedKeys(),
    });
  }, [snapshot, canEstimateCost, graph, promptFocused]);

  const queryResult = trpc.orchestrator.whatIfFromGraph.useQuery(queryPayload as any, {
    enabled: enabled && !!currentUser && !!queryPayload && !resourcesLoading,
  });

  return {
    ...queryResult,
    isValid,
    isLoading: queryResult.isFetching,
    validationErrors: validationResult?.success === false ? validationResult.errors : undefined,
  };
}
