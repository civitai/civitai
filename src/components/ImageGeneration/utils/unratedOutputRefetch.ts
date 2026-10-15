import type { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import type { InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { updateWorkflowsStatus } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { queryClient, trpc } from '~/utils/trpc';
import { isNeverRatedVideoStep, isUnratedOutput } from '~/shared/orchestrator/workflow-data';
import type { NormalizedWorkflowStepOutput } from '~/server/services/orchestrator/orchestration-new.service';

// No step event follows the rating of a finished workflow, so the generator re-reads it on a timer.
export const UNRATED_REFETCH_INTERVAL_MS = 2000;
export const UNRATED_REFETCH_MAX_ATTEMPTS = 6;

type CachedWorkflow = {
  id: string;
  metadata?: { params?: Record<string, unknown> | null } | null;
  steps: Array<
    Parameters<typeof isNeverRatedVideoStep>[0] & {
      output?: Array<Partial<NormalizedWorkflowStepOutput>>;
    }
  >;
};

export function selectUnratedRefetch(
  workflows: CachedWorkflow[],
  attempts: ReadonlyMap<string, number>
) {
  const workflowIds = new Set<string>();
  const blobIds = new Set<string>();
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      const neverRated = isNeverRatedVideoStep(step, workflow.metadata?.params);
      for (const output of step.output ?? []) {
        if (!output.id || !isUnratedOutput(output as NormalizedWorkflowStepOutput, neverRated))
          continue;
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

  function schedule() {
    if (timer) return;
    if (!selectUnratedRefetch(readWorkflows(), attempts).workflowIds.length) return;
    timer = setTimeout(run, UNRATED_REFETCH_INTERVAL_MS);
  }

  return schedule;
}

/** Every workflow in every cached generator list, across filters and pages. */
export function readCachedGeneratorWorkflows(
  client: Pick<QueryClient, 'getQueriesData'> = queryClient
) {
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  return client
    .getQueriesData<InfiniteTextToImageRequests>({ queryKey, exact: false })
    .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? []) as CachedWorkflow[];
}

export const scheduleUnratedRefetch = createUnratedRefetchScheduler({
  readWorkflows: () => readCachedGeneratorWorkflows(),
  refetch: updateWorkflowsStatus,
});
