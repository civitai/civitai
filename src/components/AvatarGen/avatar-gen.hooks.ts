import { useEffect } from 'react';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import type { WorkflowData } from '~/shared/orchestrator/workflow-data';

const listOptions = { ignoreFilters: true, includeTags: false } as const;

const TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled', 'expired', 'deleted'];
const POLL_INTERVAL_MS = 4000;

function isWorkflowPending(workflow: WorkflowData) {
  return !TERMINAL_STATUSES.includes(workflow.status) && workflow.awaitingOutput;
}

/**
 * The generator's own submits register for signal fallback polling; this list is queried
 * separately, so it refetches itself until nothing in it is still running.
 */
function usePollWhilePending(query: ReturnType<typeof useGetTextToImageRequests>) {
  const pending = query.data.some(isWorkflowPending);
  const { refetch } = query;
  useEffect(() => {
    if (!pending) return;
    const interval = setInterval(() => refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [pending, refetch]);
}

/** Every avatar generation, newest first. */
export function useAvatarFeed() {
  const generations = useGetTextToImageRequests({ tags: ['avatar'], take: 20 }, listOptions);
  usePollWhilePending(generations);
  return { ...generations, items: generations.data };
}
