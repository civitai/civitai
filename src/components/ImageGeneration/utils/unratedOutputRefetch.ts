import type { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import type { InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { updateWorkflowsStatus } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { queryClient, trpc } from '~/utils/trpc';
import { isNeverRatedVideoStep, isUnratedOutput } from '~/shared/orchestrator/workflow-data';
import type { NormalizedWorkflowStepOutput } from '~/server/services/orchestrator/orchestration-new.service';

// A blob HEAD waits for the scan verdict, and a failed scan is only resubmitted by a read, so an
// unrated output keeps one HEAD open until it is rated. The blob verdict can lag the workflow's
// rating, so a HEAD that keeps failing falls back to re-reading the workflow.
export const UNRATED_RETRY_MIN_MS = 2000;
export const UNRATED_RETRY_MAX_MS = 60_000;
export const UNRATED_GIVE_UP_MS = 10 * 60_000;
// A given-up output is watched once more after this long (an outage can outlast one watch), then
// left alone until the page is reloaded.
export const UNRATED_GIVE_UP_COOLDOWN_MS = 10 * 60_000;
const UNRATED_MAX_GIVE_UPS = 2;

export function unratedRetryDelay(attempt: number) {
  return Math.min(UNRATED_RETRY_MIN_MS * 2 ** attempt, UNRATED_RETRY_MAX_MS);
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

type UnratedOutput = { workflowId: string; url: string };

export type BlobVerdict = { nsfwLevel?: string; blockedReason?: string };

export function selectUnratedOutputs(workflows: CachedWorkflow[]) {
  const unrated = new Map<string, UnratedOutput>();
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      const neverRated = isNeverRatedVideoStep(step, workflow.metadata?.params);
      for (const output of step.output ?? []) {
        if (!output.id || !output.url) continue;
        if (!isUnratedOutput(output as NormalizedWorkflowStepOutput, neverRated)) continue;
        unrated.set(output.id, { workflowId: workflow.id, url: output.url });
      }
    }
  }
  return unrated;
}

/** Resolves once the orchestrator has a verdict for the blob; rejects on a failed scan or error. */
export async function readBlobVerdict(url: string): Promise<BlobVerdict> {
  const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  const nsfwLevel = response.headers.get('X-NSFW-Level')?.toLowerCase();
  const blockedReason = response.headers.get('X-Blocked-Reason') ?? undefined;
  if (!response.ok || (!nsfwLevel && !blockedReason))
    throw new Error(`blob verdict unavailable (${response.status})`);
  return { nsfwLevel, blockedReason };
}

export function createUnratedOutputWatcher({
  readWorkflows,
  readVerdict,
  applyRating,
  refetch,
}: {
  readWorkflows: () => CachedWorkflow[];
  readVerdict: (url: string) => Promise<BlobVerdict>;
  applyRating: (outputId: string, nsfwLevel: string) => void;
  refetch: (workflowIds: string[]) => Promise<unknown>;
}) {
  const watching = new Set<string>();
  // `watch()` runs on every cache change, including the refetch's own, so a released output whose
  // workflow still reads unrated would otherwise restart at once, for as long as the tab is open.
  // Blocked verdicts that had their one workflow re-read are settled for good; give-ups wait out a
  // cooldown, and are settled for good after the last one.
  const settled = new Set<string>();
  const gaveUp = new Map<string, { at: number; times: number }>();

  function isResting(outputId: string) {
    if (settled.has(outputId)) return true;
    const last = gaveUp.get(outputId);
    if (!last) return false;
    return last.times >= UNRATED_MAX_GIVE_UPS || Date.now() - last.at < UNRATED_GIVE_UP_COOLDOWN_MS;
  }
  // Outputs of one workflow share a single refetch.
  const refetching = new Map<string, Promise<unknown>>();

  function refetchWorkflow(workflowId: string) {
    let pending = refetching.get(workflowId);
    if (!pending) {
      pending = refetch([workflowId])
        .catch((error) => console.error('[generation] unrated output refetch failed', error))
        .finally(() => refetching.delete(workflowId));
      refetching.set(workflowId, pending);
    }
    return pending;
  }

  async function follow(outputId: string, { workflowId, url }: UnratedOutput) {
    const isUnrated = () => selectUnratedOutputs(readWorkflows()).has(outputId);
    const watchedAt = Date.now();
    try {
      let failures = 0;
      let failedReads = 0;
      for (;;) {
        const startedAt = Date.now();
        const verdict = await readVerdict(url).catch(() => null);
        if (verdict) {
          // The output's blocked state comes from the workflow, which a header can't reproduce.
          if (verdict.blockedReason || !verdict.nsfwLevel) {
            settled.add(outputId);
            await refetch([workflowId]);
          } else applyRating(outputId, verdict.nsfwLevel);
          return;
        }
        // A long wait cut off (an API pod shutting down in a deploy) is not a run of failures.
        if (Date.now() - startedAt >= UNRATED_RETRY_MAX_MS) failures = 0;
        if (++failedReads >= 2) {
          await refetchWorkflow(workflowId);
          if (!isUnrated()) return;
        }
        if (Date.now() - watchedAt >= UNRATED_GIVE_UP_MS) {
          console.warn('[generation] gave up waiting for an output rating', outputId);
          gaveUp.set(outputId, { at: Date.now(), times: (gaveUp.get(outputId)?.times ?? 0) + 1 });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, unratedRetryDelay(failures++)));
        if (!isUnrated()) return;
      }
    } catch (error) {
      console.error('[generation] unrated output verdict failed', error);
    } finally {
      watching.delete(outputId);
    }
  }

  return function watch() {
    for (const [outputId, output] of selectUnratedOutputs(readWorkflows())) {
      if (watching.has(outputId) || isResting(outputId)) continue;
      watching.add(outputId);
      void follow(outputId, output);
    }
  };
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

export function applyCachedOutputRating(
  outputId: string,
  nsfwLevel: string,
  client: Pick<QueryClient, 'setQueriesData'> = queryClient
) {
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  client.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      for (const workflow of old?.pages.flatMap((page) => page.items) ?? [])
        for (const step of workflow.steps)
          for (const output of step.output ?? [])
            if (output.id === outputId) (output as { nsfwLevel?: string }).nsfwLevel = nsfwLevel;
    })
  );
}

export const watchUnratedOutputs = createUnratedOutputWatcher({
  readWorkflows: () => readCachedGeneratorWorkflows(),
  readVerdict: readBlobVerdict,
  applyRating: (outputId, nsfwLevel) => applyCachedOutputRating(outputId, nsfwLevel),
  refetch: updateWorkflowsStatus,
});
