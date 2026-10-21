import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getQueryKey } from '@trpc/react-query';
import type { InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { updateWorkflowsStatus } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { queryClient, trpc } from '~/utils/trpc';
import { isNeverRatedVideoStep, isUnratedOutput } from '~/shared/orchestrator/workflow-data';
import type { NormalizedWorkflowStepOutput } from '~/server/services/orchestrator/orchestration-new.service';

// No step event follows the rating of a finished workflow, so the generator re-reads it on a timer.
// A rating can land minutes after the output; don't shorten the give-up window.
export const UNRATED_REFETCH_MIN_INTERVAL_MS = 2000;
export const UNRATED_REFETCH_MAX_INTERVAL_MS = 20_000;
export const UNRATED_REFETCH_GIVE_UP_MS = 5 * 60_000;

/** Waits half the output's age, so each output backs off on its own clock. */
export function nextUnratedRefetchDelay(ageMs: number) {
  return Math.min(
    Math.max(ageMs / 2, UNRATED_REFETCH_MIN_INTERVAL_MS),
    UNRATED_REFETCH_MAX_INTERVAL_MS
  );
}

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
  /** Output id to the workflow that holds it. */
  const waiting = new Map<string, string>();
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      const neverRated = isNeverRatedVideoStep(step, workflow.metadata?.params);
      for (const output of step.output ?? []) {
        if (!output.id || !isUnratedOutput(output as NormalizedWorkflowStepOutput, neverRated))
          continue;
        if (now - (firstSeen.get(output.id) ?? now) >= UNRATED_REFETCH_GIVE_UP_MS) continue;
        waiting.set(output.id, workflow.id);
      }
    }
  }
  return waiting;
}

export function createUnratedRefetchScheduler({
  readWorkflows,
  refetch,
}: {
  readWorkflows: () => CachedWorkflow[];
  refetch: (workflowIds: string[]) => Promise<unknown>;
}) {
  const firstSeen = new Map<string, number>();
  const nextAt = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run() {
    timer = undefined;
    const now = Date.now();
    const workflowIds = new Set<string>();
    for (const [id, workflowId] of selectUnratedRefetch(readWorkflows(), firstSeen, now)) {
      if ((nextAt.get(id) ?? Infinity) > now) continue;
      workflowIds.add(workflowId);
      nextAt.set(id, now + nextUnratedRefetchDelay(now - (firstSeen.get(id) ?? now)));
    }
    if (workflowIds.size)
      await refetch([...workflowIds]).catch((error) =>
        console.error('[generation] unrated output refetch failed', error)
      );
    schedule();
  }

  function schedule() {
    const now = Date.now();
    let earliest = Infinity;
    for (const id of selectUnratedRefetch(readWorkflows(), firstSeen, now).keys()) {
      if (!firstSeen.has(id)) {
        firstSeen.set(id, now);
        nextAt.set(id, now + UNRATED_REFETCH_MIN_INTERVAL_MS);
      }
      earliest = Math.min(earliest, nextAt.get(id) ?? now);
    }
    clearTimeout(timer);
    timer = earliest === Infinity ? undefined : setTimeout(run, Math.max(earliest - now, 0));
  }

  /** Starts a workflow's outputs over at the first interval, with a fresh give-up window. */
  function restart(workflowId: string) {
    for (const workflow of readWorkflows())
      if (workflow.id === workflowId)
        for (const step of workflow.steps ?? [])
          for (const { id } of step.output ?? []) {
            if (!id) continue;
            firstSeen.delete(id);
            nextAt.delete(id);
          }
  }

  return Object.assign(schedule, { restart });
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

// Only workflows with a card on screen are re-read, so scrolled-away history costs nothing.
const onScreen = new Map<string, number>();

export const scheduleUnratedRefetch = createUnratedRefetchScheduler({
  readWorkflows: () => readCachedGeneratorWorkflows().filter(({ id }) => onScreen.has(id)),
  refetch: updateWorkflowsStatus,
});

/** Returns the unwatch; a workflow stays watched until every watcher has unwatched. */
export function watchUnratedRefetch(workflowId: string) {
  const watchers = onScreen.get(workflowId) ?? 0;
  onScreen.set(workflowId, watchers + 1);
  // Its rating may have landed while nothing re-read it, even past the give-up window.
  if (!watchers) scheduleUnratedRefetch.restart(workflowId);
  scheduleUnratedRefetch();
  return () => {
    const count = (onScreen.get(workflowId) ?? 0) - 1;
    if (count > 0) onScreen.set(workflowId, count);
    else onScreen.delete(workflowId);
  };
}

type HoldingWorkflow = { id: string; pendingRatingOutput: unknown[] };

/** Watches the workflows holding an output for its rating. */
export function createHeldOutputsWatch() {
  let unwatch: Array<() => void> = [];
  return {
    update(workflows: HoldingWorkflow[]) {
      // Watch the new set before dropping the old, so a workflow in both keeps its window.
      const next = workflows
        .filter((workflow) => workflow.pendingRatingOutput.length)
        .map((workflow) => watchUnratedRefetch(workflow.id));
      unwatch.forEach((fn) => fn());
      unwatch = next;
    },
    stop() {
      unwatch.forEach((fn) => fn());
      unwatch = [];
    },
  };
}

/**
 * For lists with no tile for an output held for its rating (the feed, the media pickers): watches
 * the workflows holding one while the list is mounted.
 */
export function useWatchHeldOutputs(workflows: HoldingWorkflow[]) {
  // Keyed by the held ids, so a cache write that changes none of them does no work.
  const held = workflows.filter((workflow) => workflow.pendingRatingOutput.length);
  const key = held.map(({ id }) => id).join(',');
  const watch = useRef<ReturnType<typeof createHeldOutputsWatch>>();
  watch.current ??= createHeldOutputsWatch();
  useEffect(() => {
    watch.current?.update(held);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => watch.current?.stop(), []);
}
