/**
 * Generic Workflow Hooks
 *
 * Tag-based workflow query, cache management, and signal handling.
 * Used by prompt enhancement, future text workflows, and any workflow
 * that queries/caches by tags.
 */

import type { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { queryClient, trpc, trpcVanilla } from '~/utils/trpc';

// =============================================================================
// Types
// =============================================================================

export type WorkflowItem = {
  id: string;
  createdAt: string;
  status: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  steps: Array<{
    name: string;
    $type?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
};

type WorkflowPage = {
  nextCursor: string | undefined;
  items: WorkflowItem[];
};

type WorkflowSignalEvent = {
  $type: string;
  workflowId: string;
  status?: string;
};

// =============================================================================
// Cache helpers (tag-based)
// =============================================================================

function getQueryKeyForTags(_tags: string[]) {
  // Use the procedure-level key without input to match all queries for this endpoint.
  // `exact: false` in setQueriesData ensures it matches regardless of pagination params.
  return getQueryKey(trpc.orchestrator.queryWorkflowsByTags);
}

export function addWorkflowToTagCache(workflow: WorkflowItem, tags: string[]) {
  const queryKey = getQueryKeyForTags(tags);
  queryClient.setQueriesData(
    { queryKey, exact: false },
    (state: InfiniteData<WorkflowPage> | undefined) =>
      produce(state, (old) => {
        if (!old?.pages?.[0]) return;
        old.pages[0].items.unshift(workflow);
      })
  );
}

export function updateWorkflowInTagCache(workflow: WorkflowItem, tags: string[]) {
  const queryKey = getQueryKeyForTags(tags);
  queryClient.setQueriesData(
    { queryKey, exact: false },
    (state: InfiniteData<WorkflowPage> | undefined) =>
      produce(state, (old) => {
        if (!old?.pages) return;
        for (const page of old.pages) {
          const index = page.items.findIndex((item) => item.id === workflow.id);
          if (index !== -1) {
            page.items[index] = workflow;
            return;
          }
        }
      })
  );
}

// =============================================================================
// Fetch workflow by ID
// =============================================================================

export async function fetchWorkflowById(workflowId: string): Promise<WorkflowItem> {
  const workflow = await trpcVanilla.orchestrator.getWorkflow.query({ workflowId });
  return workflow as unknown as WorkflowItem;
}

// =============================================================================
// Signal hook
// =============================================================================

export type WorkflowSignalHandler = (event: WorkflowSignalEvent) => void;

/**
 * Hook to listen for generic workflow update signals.
 * Calls the handler when a WorkflowUpdate signal arrives.
 */
export function useWorkflowSignal(handler: WorkflowSignalHandler) {
  useSignalConnection(SignalMessages.WorkflowUpdate, handler);
}
