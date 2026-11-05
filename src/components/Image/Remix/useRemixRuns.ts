import { getQueryKey } from '@trpc/react-query';
import { useMemo } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import {
  setCachedWorkflowTag,
  useGetTextToImageRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { SignalMessages } from '~/server/common/enums';
import { SYSTEM_REMIX_APPS } from '~/shared/constants/remix-apps.constants';
import type { WorkflowData } from '~/shared/orchestrator/workflow-data';
import {
  readRemixTag,
  REMIX_APP_TAG,
  REMIX_DISMISSED_TAG,
  REMIX_DONE_TAG,
  REMIX_RUN_TAG_PREFIX,
  REMIX_SEGMENT_TAG_PREFIX,
} from '~/shared/remix-apps/tags';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc, trpcVanilla } from '~/utils/trpc';

export type RemixRunStatus = 'running' | 'ready' | 'failed';

export type RemixRun = {
  runId: string;
  slug: string;
  appName: string;
  /** The latest segment's workflow: the one tray state is tagged on. */
  workflowId: string;
  status: RemixRunStatus;
  thumbnailUrl?: string;
};

const RUNNING = ['unassigned', 'preparing', 'scheduled', 'processing'];
const QUERY_INPUT = { tags: [REMIX_APP_TAG] };

function runStatus(workflow: WorkflowData): RemixRunStatus {
  if (RUNNING.includes(workflow.status as string)) return 'running';
  return workflow.status === 'succeeded' ? 'ready' : 'failed';
}

/** One row per run, from its latest segment; posted and dismissed runs are left out. */
export function groupRemixRuns(workflows: WorkflowData[]): RemixRun[] {
  const latest = new Map<string, { workflow: WorkflowData; index: number }>();
  for (const workflow of workflows) {
    const runId = readRemixTag(workflow.tags, REMIX_RUN_TAG_PREFIX);
    const index = Number(readRemixTag(workflow.tags, REMIX_SEGMENT_TAG_PREFIX));
    if (!runId || !Number.isInteger(index)) continue;
    const seen = latest.get(runId);
    if (!seen || index > seen.index) latest.set(runId, { workflow, index });
  }

  const runs: RemixRun[] = [];
  for (const [runId, { workflow }] of latest) {
    const tags = workflow.tags ?? [];
    if (tags.includes(REMIX_DONE_TAG) || tags.includes(REMIX_DISMISSED_TAG)) continue;
    const slug = readRemixTag(tags, `${REMIX_APP_TAG}:`);
    if (!slug) continue;
    runs.push({
      runId,
      slug,
      appName: SYSTEM_REMIX_APPS.find((app) => app.slug === slug)?.name ?? slug,
      workflowId: workflow.id as string,
      status: runStatus(workflow),
      // Through `succeededOutput`, so an output the viewer may not see never becomes a thumbnail.
      thumbnailUrl: workflow.succeededOutput[0]?.url,
    });
  }
  return runs;
}

// Module scope: every mounted tray shares one signal stream, so each id is fetched once.
const checkedWorkflowIds = new Set<string>();

/**
 * The viewer's open remix runs, read from the queue's own query (so its status signals keep them
 * current), plus any run started elsewhere that the queue has not listed yet.
 */
export function useRemixRuns({ enabled = true }: { enabled?: boolean } = {}) {
  const { data, isLoading } = useGetTextToImageRequests(QUERY_INPUT, {
    enabled,
    includeTags: false,
    ignoreFilters: true,
  });
  const runs = useMemo(() => groupRemixRuns(data), [data]);
  const inProgress = runs.filter((run) => run.status === 'running').length;
  const ready = runs.length - inProgress;

  // The queue's status signals skip a workflow it has never listed: look an unseen id up once.
  useSignalConnection(SignalMessages.TextToImageUpdate, (event: { workflowId?: string }) => {
    const workflowId = event?.workflowId;
    if (!enabled || !workflowId || checkedWorkflowIds.has(workflowId)) return;
    if (data.some((workflow) => workflow.id === workflowId)) return;
    checkedWorkflowIds.add(workflowId);
    trpcVanilla.orchestrator.getWorkflow
      .query({ workflowId })
      .then((workflow) => {
        if (!workflow?.tags?.includes(REMIX_APP_TAG)) return;
        return queryClient.invalidateQueries({
          queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
          exact: false,
        });
      })
      .catch(() => checkedWorkflowIds.delete(workflowId));
  });

  const patch = trpc.orchestrator.patch.useMutation();
  function dismiss(run: Pick<RemixRun, 'workflowId'>) {
    // Optimistic, in every queue list: the row leaves at once, and the queue sees the tag too.
    setCachedWorkflowTag(run.workflowId, REMIX_DISMISSED_TAG, 'add');
    patch.mutate(
      { tags: [{ workflowId: run.workflowId, tag: REMIX_DISMISSED_TAG, op: 'add' }] },
      {
        onError: (error) => {
          setCachedWorkflowTag(run.workflowId, REMIX_DISMISSED_TAG, 'remove');
          showErrorNotification({ title: 'Could not dismiss', error: new Error(error.message) });
        },
      }
    );
  }

  return { runs, inProgress, ready, isLoading, dismiss };
}
