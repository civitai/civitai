/**
 * useWhatIfFromGraph
 *
 * Hook that fetches cost estimation (what-if) data for the generation graph.
 * Debounces the request and only fetches when the user is logged in.
 */

import { useDebouncedValue } from '@mantine/hooks';
import { useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { trpc } from '~/utils/trpc';

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

  // Subscribe to graph changes and get snapshot on each change
  // Using useState + useEffect instead of useGraphValues because getSnapshot()
  // returns the same object reference, which doesn't trigger useSyncExternalStore
  const [values, setValues] = useState(() => graph.getSnapshot());
  useEffect(() => {
    // Update immediately with current snapshot
    setValues(graph.getSnapshot());
    // Subscribe to future changes
    return graph.subscribe(() => setValues(graph.getSnapshot()));
  }, [graph]);

  // Debounce the values to avoid excessive API calls and validation runs
  const [debouncedValues] = useDebouncedValue(values, 150);

  // Check if the graph data is valid using validate (doesn't save error state)
  // Only run validation on debounced values to avoid running on every keystroke
  const validationResult = useMemo(
    () => (debouncedValues ? graph.validate({ saveState: false }) : null),
    [debouncedValues, graph]
  );
  const isValid = validationResult?.success ?? false;

  // Build the query payload (only if valid) - server builds the external context
  const queryPayload = useMemo(() => {
    if (!debouncedValues || !isValid) return null;
    return debouncedValues;
  }, [debouncedValues, isValid]);

  const queryResult = trpc.orchestrator.whatIfFromGraph.useQuery(queryPayload as any, {
    enabled: enabled && !!currentUser && !!queryPayload,
  });

  return {
    ...queryResult,
    isValid,
    validationErrors: validationResult?.success === false ? validationResult.errors : undefined,
  };
}
