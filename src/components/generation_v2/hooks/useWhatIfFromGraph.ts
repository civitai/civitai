/**
 * useWhatIfFromGraph
 *
 * Hook that fetches cost estimation (what-if) data for the generation graph.
 *
 * Prompt changes do NOT trigger re-fetches — the site identity (not prompt content)
 * determines the buzz type, and prompt moderation happens at submission time.
 * The user-selected buzz type from the generation form store is included in the
 * query payload so the backend resolves the correct currency.
 */

import { isEqual, omit } from 'lodash-es';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { NodeError } from '~/libs/data-graph/data-graph';
import { useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import { applyWhatIfFingerprints } from '~/shared/data-graph/generation/whatif-fingerprints';
import { defaultWorkflowCost } from '~/shared/orchestrator/workflow-data';
import { trpc } from '~/utils/trpc';
import { useResourceDataContext } from '../inputs/ResourceDataProvider';
import { filterSnapshotForSubmit } from '../utils';
import { useImagesUploadingOrVerifying } from '~/components/Generation/Input/SourceImageUploadMultiple';

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
  const imagesPending = useImagesUploadingOrVerifying();

  // Track graph changes with a revision counter
  const [revision, incrementRevision] = useReducer((r: number) => r + 1, 0);
  const prevSnapshotRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    // Per-node fingerprints (declared in whatif-fingerprints.ts) project each
    // value to the slice that actually affects cost — stripping sub-fields
    // like `strength` on resources or `weight`/`startStep`/`endStep` on
    // controlNets, and dropping content-only fields like `prompt`/`seed`.
    // Computed keys are stripped on top because they're derived from other
    // nodes' values, so they'd cause double-counting.
    const computedKeys = graph.getComputedKeys();
    const buildRelevant = () =>
      omit(applyWhatIfFingerprints(graph.getSnapshot() as Record<string, unknown>), computedKeys);

    prevSnapshotRef.current = buildRelevant();

    return graph.subscribe(() => {
      const relevantSnapshot = buildRelevant();
      if (!isEqual(relevantSnapshot, prevSnapshotRef.current)) {
        prevSnapshotRef.current = relevantSnapshot;
        incrementRevision();
      }
    });
  }, [graph]);

  // Get current snapshot for building the query
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const snapshot = useMemo(() => graph.getSnapshot() as Record<string, unknown>, [revision, graph]);

  // Validate snapshot with placeholders for content fields. These don't affect
  // pricing (site identity determines buzz type), but the graph may require
  // them to be non-empty for validation (e.g. ACE audio's musicDescription).
  const validationResult = useMemo(() => {
    if (!snapshot) return null;
    return graph.validate({
      ...snapshot,
      prompt: (snapshot.prompt as string) || 'cost estimation',
      musicDescription: (snapshot.musicDescription as string) || 'cost estimation',
    });
  }, [snapshot, graph]);

  const canEstimateCost = validationResult?.success ?? false;

  // Build the query payload from validated data.
  // Note: buzz type is NOT included here — cost is the same regardless of which
  // buzz type the user selects. Buzz type only matters at submission time.
  // Content fields (prompt/negativePrompt for image/video, musicDescription/
  // lyrics for ACE audio) are stripped — they don't affect cost and shouldn't
  // be sent to the server until actual submission.
  const queryPayload = useMemo(() => {
    if (!validationResult?.success) return null;

    const outputSnapshot = omit(validationResult.data as Record<string, unknown>, [
      'prompt',
      'negativePrompt',
      'musicDescription',
      'lyrics',
      'styleReferences', // Krea 2
    ]);

    return filterSnapshotForSubmit(outputSnapshot, {
      computedKeys: graph.getComputedKeys(),
    });
  }, [validationResult, graph]);

  // Disable whatIf for workflows that don't submit (e.g. img2meta).
  // Model3D workflows now ride the unified `whatIfFromGraph` path like every
  // other ecosystem — no special-case gate needed.
  const workflowConfig = workflowConfigByKey.get(snapshot?.workflow as string);
  const isNoSubmit = workflowConfig?.noSubmit === true;

  const queryResult = trpc.orchestrator.whatIfFromGraph.useQuery(queryPayload as any, {
    enabled:
      enabled &&
      !isNoSubmit &&
      !!currentUser &&
      !!queryPayload &&
      !resourcesLoading &&
      !imagesPending,
  });

  const data = useMemo(
    () =>
      queryResult.data ?? {
        cost: defaultWorkflowCost,
        ready: false,
        allowMatureContent: false,
        transactions: undefined,
      },
    [queryResult.data]
  );

  const validationErrors =
    validationResult && !validationResult.success ? validationResult.errors : null;

  return {
    ...queryResult,
    data,
    isLoading: queryResult.isFetching || imagesPending,
    canEstimateCost,
    validationErrors,
  };
}
