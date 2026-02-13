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
import type { NodeError } from '~/libs/data-graph/data-graph';
import { useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { trpc } from '~/utils/trpc';
import { useResourceDataContext } from '../inputs/ResourceDataProvider';
import { filterSnapshotForSubmit } from '../utils';
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
// Helper Functions
// =============================================================================

/**
 * Get a user-friendly message from validation errors explaining why generation cannot proceed.
 * Returns null if there are no errors.
 */
export function getMissingFieldMessage(errors: Record<string, NodeError> | null): string | null {
  if (!errors) return null;

  // Return the first error message found (errors are in graph node order)
  for (const error of Object.values(errors)) {
    if (error.message) return error.message;
  }

  return null;
}

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
  const snapshot = useMemo(() => graph.getSnapshot() as Record<string, unknown>, [revision, graph]);

  // Update committed prompt when not focused
  useEffect(() => {
    if (!promptFocused && snapshot?.prompt !== undefined) {
      promptRef.current = snapshot.prompt as string;
    }
  }, [promptFocused, snapshot?.prompt]);

  // Validate snapshot with a placeholder prompt for cost estimation.
  // The prompt value affects SFW/NSFW classification and pricing, but we don't want
  // to block cost estimation when the user hasn't typed a prompt yet.
  const validationResult = useMemo(() => {
    if (!snapshot) return null;
    return graph.validate({
      ...snapshot,
      prompt: (snapshot.prompt as string) || 'cost estimation',
    });
  }, [snapshot, graph]);

  console.log({ validationResult, snapshot });

  const canEstimateCost = validationResult?.success ?? false;

  // Build the query payload from validated data.
  // When prompt is focused, use the last committed value to avoid race conditions with submit.
  const queryPayload = useMemo(() => {
    if (!validationResult?.success) return null;

    const outputSnapshot = validationResult.data as Record<string, unknown>;

    // When focused, use committed prompt value to avoid race conditions with submit
    // When not focused, use current snapshot value directly (effect updates ref for next focus)
    const promptValue = promptFocused ? promptRef.current : (outputSnapshot.prompt as string);
    const snapshotForQuery = { ...outputSnapshot, prompt: promptValue };

    return filterSnapshotForSubmit(snapshotForQuery, {
      computedKeys: graph.getComputedKeys(),
    });
  }, [validationResult, graph, promptFocused]);

  const queryResult = trpc.orchestrator.whatIfFromGraph.useQuery(queryPayload as any, {
    enabled: enabled && !!currentUser && !!queryPayload && !resourcesLoading,
  });

  const validationErrors =
    validationResult && !validationResult.success ? validationResult.errors : null;

  return {
    ...queryResult,
    isLoading: queryResult.isFetching,
    canEstimateCost,
    validationErrors,
  };
}
