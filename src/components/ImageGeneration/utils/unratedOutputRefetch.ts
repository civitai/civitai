import { getQueryKey } from '@trpc/react-query';
import type { InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { updateWorkflowsStatus } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { queryClient, trpc } from '~/utils/trpc';
import { isUnratedOutput } from '~/shared/orchestrator/workflow-data';
import type { NormalizedWorkflowStepOutput } from '~/server/services/orchestrator/orchestration-new.service';

/**
 * A workflow often reaches `succeeded` a few seconds before its last output is rated, and no step
 * event follows the rating, so the generator re-reads the workflow itself.
 */
export const UNRATED_REFETCH_INTERVAL_MS = 2000;
export const UNRATED_REFETCH_MAX_ATTEMPTS = 6;

type CachedWorkflow = {
  id: string;
  steps: Array<{ output?: Array<Partial<NormalizedWorkflowStepOutput>> }>;
};

/** Which workflows to re-read for a missing rating, and the outputs that re-read is spent on. */
export function selectUnratedRefetch(
  workflows: CachedWorkflow[],
  attempts: ReadonlyMap<string, number>
) {
  const workflowIds = new Set<string>();
  const blobIds = new Set<string>();
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      for (const output of step.output ?? []) {
        if (!output.id || !isUnratedOutput(output as NormalizedWorkflowStepOutput)) continue;
        if ((attempts.get(output.id) ?? 0) >= UNRATED_REFETCH_MAX_ATTEMPTS) continue;
        workflowIds.add(workflow.id);
        blobIds.add(output.id);
      }
    }
  }
  return { workflowIds: [...workflowIds], blobIds: [...blobIds] };
}

export function createUnratedRefetchScheduler({
  readWorkflows,
  refetch,
}: {
  readWorkflows: () => CachedWorkflow[];
  refetch: (workflowIds: string[]) => Promise<unknown>;
}) {
  const attempts = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run() {
    timer = undefined;
    const { workflowIds, blobIds } = selectUnratedRefetch(readWorkflows(), attempts);
    if (!workflowIds.length) return;
    for (const id of blobIds) attempts.set(id, (attempts.get(id) ?? 0) + 1);
    await refetch(workflowIds).catch((error) =>
      console.error('[generation] unrated output refetch failed', error)
    );
    schedule();
  }

  /** Re-reads cached workflows that still hold an unrated output, until rated or out of attempts. */
  function schedule() {
    if (timer) return;
    if (!selectUnratedRefetch(readWorkflows(), attempts).workflowIds.length) return;
    timer = setTimeout(run, UNRATED_REFETCH_INTERVAL_MS);
  }

  return schedule;
}

export const scheduleUnratedRefetch = createUnratedRefetchScheduler({
  readWorkflows: () => {
    const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
    return queryClient
      .getQueriesData<InfiniteTextToImageRequests>({ queryKey, exact: false })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? []) as CachedWorkflow[];
  },
  refetch: updateWorkflowsStatus,
});
