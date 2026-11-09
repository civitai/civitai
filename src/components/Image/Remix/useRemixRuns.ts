import { getQueryKey } from '@trpc/react-query';
import { useMemo } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import {
  setCachedWorkflowTag,
  useGetTextToImageRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { SignalMessages } from '~/server/common/enums';
import { TEAM_REMIX_APP } from '~/shared/constants/remix-apps.constants';
import type { WorkflowData } from '~/shared/orchestrator/workflow-data';
import {
  readRemixTag,
  REMIX_APP_TAG,
  REMIX_DISMISSED_TAG,
  REMIX_DONE_TAG,
  REMIX_RUN_TAG_PREFIX,
  REMIX_SEGMENT_TAG_PREFIX,
  isRuntimeRun,
} from '~/shared/remix-apps/tags';
import { useRemixAppList } from '~/components/Image/Remix/useRemixAppList';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

export type RemixRunStatus = 'running' | 'ready' | 'failed';

export type RemixRun = {
  runId: string;
  slug: string;
  appName: string;
  /** The latest segment's workflow: the one tray state is tagged on. */
  workflowId: string;
  status: RemixRunStatus;
  thumbnailUrl?: string;
  /** The image it remixes, from the workflow's own metadata. */
  imageId?: number;
  /** Advanced through `remixApp.advance`; a one-shot run is its single workflow. */
  runtime: boolean;
};

const RUNNING = ['unassigned', 'preparing', 'scheduled', 'processing'];

export const isRunningWorkflow = (workflow: Pick<WorkflowData, 'status'>) =>
  RUNNING.includes(workflow.status as string);
const QUERY_INPUT = { tags: [REMIX_APP_TAG] };

function runStatus(workflow: WorkflowData): RemixRunStatus {
  if (isRunningWorkflow(workflow)) return 'running';
  return workflow.status === 'succeeded' ? 'ready' : 'failed';
}

/** One row per run, from its latest segment; posted and dismissed runs are left out. */
export function groupRemixRuns(
  workflows: WorkflowData[],
  apps: readonly { slug: string; name: string }[]
): RemixRun[] {
  const names = new Map([...apps, TEAM_REMIX_APP].map((app) => [app.slug, app.name]));
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
      appName: names.get(slug) ?? slug,
      runtime: isRuntimeRun(slug, tags),
      imageId: workflow.remixOfId,
      workflowId: workflow.id as string,
      status: runStatus(workflow),
      // Through `succeededOutput`, so an output the viewer may not see never becomes a thumbnail.
      thumbnailUrl: workflow.succeededOutput[0]?.url,
    });
  }
  return runs;
}

/** The viewer's remix-app workflows, newest first: the tray's runs and the menu's recents. */
export function useRemixWorkflows({ enabled = true }: { enabled?: boolean } = {}) {
  return useGetTextToImageRequests(QUERY_INPUT, {
    enabled,
    includeTags: false,
    ignoreFilters: true,
  });
}

// Module scope: every mounted tray shares one signal stream, so each id is refetched for once.
const signaledWorkflowIds = new Set<string>();

/**
 * The viewer's open remix runs, read from the queue's own query (so its status signals keep them
 * current), plus any run started elsewhere that the queue has not listed yet.
 */
export function useRemixRuns({ enabled = true }: { enabled?: boolean } = {}) {
  const { data, isLoading } = useRemixWorkflows({ enabled });
  const apps = useRemixAppList();
  const runs = useMemo(() => groupRemixRuns(data, apps), [data, apps]);
  const inProgress = runs.filter((run) => run.status === 'running').length;
  const ready = runs.length - inProgress;

  // The queue's status signals skip a workflow it has never listed. Only remix-app workflows send
  // this topic, so an unseen id is a run started elsewhere: refetch the queue once for it.
  useSignalConnection(SignalMessages.RemixAppUpdate, (event: { workflowId?: string }) => {
    const workflowId = event?.workflowId;
    if (!enabled || !workflowId || signaledWorkflowIds.has(workflowId)) return;
    if (data.some((workflow) => workflow.id === workflowId)) return;
    signaledWorkflowIds.add(workflowId);
    queryClient
      .invalidateQueries({
        queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
        exact: false,
      })
      .catch(() => signaledWorkflowIds.delete(workflowId));
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

  return { runs, workflows: data, inProgress, ready, isLoading, dismiss };
}
