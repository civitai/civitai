import type { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import type { InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { updateWorkflowsStatus } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { queryClient, trpc } from '~/utils/trpc';
import { isNeverRatedVideoStep, isUnratedOutput } from '~/shared/orchestrator/workflow-data';
import type { NormalizedWorkflowStepOutput } from '~/server/services/orchestrator/orchestration-new.service';

// No step event follows the rating of a finished workflow, so the generator re-reads it on a timer.
// A rating can land minutes after the output, so the timer backs off rather than giving up early.
export const UNRATED_REFETCH_MIN_INTERVAL_MS = 2000;
export const UNRATED_REFETCH_MAX_INTERVAL_MS = 20_000;
export const UNRATED_REFETCH_BACKOFF = 1.5;
export const UNRATED_REFETCH_GIVE_UP_MS = 5 * 60_000;

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
  firstSeen: ReadonlyMap<string, number>,
  now: number
) {
  const workflowIds = new Set<string>();
  const blobIds = new Set<string>();
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      const neverRated = isNeverRatedVideoStep(step, workflow.metadata?.params);
      for (const output of step.output ?? []) {
        if (!output.id || !isUnratedOutput(output as NormalizedWorkflowStepOutput, neverRated))
          continue;
        if (now - (firstSeen.get(output.id) ?? now) >= UNRATED_REFETCH_GIVE_UP_MS) continue;
        workflowIds.add(workflow.id);
        blobIds.add(output.id);
      }
    }
  }
  return { workflowIds: [...workflowIds], blobIds: [...blobIds] };
}

/** One batched re-read per tick for every waiting output; a new output resets the backoff. */
export function createUnratedRefetchScheduler({
  readWorkflows,
  refetch,
}: {
  readWorkflows: () => CachedWorkflow[];
  refetch: (workflowIds: string[]) => Promise<unknown>;
}) {
  const firstSeen = new Map<string, number>();
  let interval = UNRATED_REFETCH_MIN_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;

  async function run() {
    timer = undefined;
    const { workflowIds } = selectUnratedRefetch(readWorkflows(), firstSeen, Date.now());
    if (!workflowIds.length) return;
    interval = Math.min(interval * UNRATED_REFETCH_BACKOFF, UNRATED_REFETCH_MAX_INTERVAL_MS);
    await refetch(workflowIds).catch((error) =>
      console.error('[generation] unrated output refetch failed', error)
    );
    schedule();
  }

  function schedule() {
    const now = Date.now();
    const { blobIds } = selectUnratedRefetch(readWorkflows(), firstSeen, now);
    if (!blobIds.length) return;
    const fresh = blobIds.filter((id) => !firstSeen.has(id));
    for (const id of fresh) firstSeen.set(id, now);
    if (fresh.length) {
      interval = UNRATED_REFETCH_MIN_INTERVAL_MS;
      if (timer && dueAt > now + interval) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
    if (timer) return;
    dueAt = now + interval;
    timer = setTimeout(run, interval);
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
