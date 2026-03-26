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

export function addWorkflowToTagCache(workflow: WorkflowItem, tags: string[]) {
  const queryKey = getQueryKey(trpc.orchestrator.queryWorkflowsByTags);
  queryClient.setQueriesData(
    {
      queryKey,
      exact: false,
      predicate: (query) => matchesTagQuery(query.queryKey, tags),
    },
    (state: InfiniteData<WorkflowPage> | undefined) =>
      produce(state, (old) => {
        if (!old?.pages?.[0]) return;
        old.pages[0].items.unshift(workflow);
      })
  );
}

export function updateWorkflowInTagCache(workflow: WorkflowItem, tags: string[]) {
  const queryKey = getQueryKey(trpc.orchestrator.queryWorkflowsByTags);
  queryClient.setQueriesData(
    {
      queryKey,
      exact: false,
      predicate: (query) => matchesTagQuery(query.queryKey, tags),
    },
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

/** Check if a query key's input tags match the target tags */
function matchesTagQuery(queryKey: readonly unknown[], tags: string[]): boolean {
  const input = (queryKey[1] as { input?: { tags?: string[] } } | undefined)?.input;
  if (!input?.tags) return true; // no tags filter — match all
  return tags.every((t) => input.tags!.includes(t));
}

// =============================================================================
// Fetch workflow by ID
// =============================================================================

export async function fetchWorkflowById(workflowId: string): Promise<WorkflowItem> {
  const workflow = await trpcVanilla.orchestrator.getWorkflow.query({ workflowId });
  return workflow as unknown as WorkflowItem;
}

// =============================================================================
// Signal listener registry
// =============================================================================

type WorkflowSignalListener = (event: WorkflowSignalEvent) => void;

const listeners = new Set<WorkflowSignalListener>();

/** Subscribe to workflow update signals. Returns an unsubscribe function. */
export function onWorkflowSignal(listener: WorkflowSignalListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hook that registers the central WorkflowUpdate signal connection.
 * Mount this once (e.g., in GenerationSignals). Dispatches to all
 * registered listeners via onWorkflowSignal.
 */
export function useWorkflowUpdateSignal() {
  useSignalConnection(SignalMessages.WorkflowUpdate, (event: WorkflowSignalEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  });
}
