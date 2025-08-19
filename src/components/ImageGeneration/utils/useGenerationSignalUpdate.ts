import type { WorkflowStepEvent } from '@civitai/client';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import type { InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { createDebouncer } from '~/utils/debouncer';
import { queryClient, trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import type { WorkflowStatusUpdate } from '~/server/services/orchestrator/common';
import { useInterval } from '@mantine/hooks';
import { COMPLETE_STATUSES, POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';

type CustomWorkflowStepEvent = Omit<WorkflowStepEvent, '$type'> & { $type: 'step' };
const debouncer = createDebouncer(100);
let signalStepEventsDictionary: Record<string, CustomWorkflowStepEvent> = {};
const incompleteWorkflowsDictionary: Record<string, boolean> = {};
export function useTextToImageSignalUpdate() {
  return useSignalConnection(SignalMessages.TextToImageUpdate, (data: CustomWorkflowStepEvent) => {
    if (data.$type === 'step' && data.status !== 'unassigned') {
      signalStepEventsDictionary[data.workflowId] = { ...data };
      if (POLLABLE_STATUSES.includes(data.status)) {
        incompleteWorkflowsDictionary[data.workflowId] = true;
      }
    }
    debouncer(() => updateSignaledWorkflows());
  });
}

async function fetchSignaledWorkflow(
  workflowId: string
): Promise<WorkflowStatusUpdate | undefined> {
  const response = await fetch(`/api/generation/workflows/${workflowId}/status-update`);
  if (response.ok) return await response.json();
  else {
    // TODO - handle errors
  }
}

export async function updateWorkflowsStatus(workflowIds: string[]) {
  if (!workflowIds.length) return;
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  const updates = await Promise.all(workflowIds.map(fetchSignaledWorkflow)).then((data) =>
    data.filter(isDefined)
  );

  for (const update of updates) {
    if (!POLLABLE_STATUSES.includes(update.status)) delete incompleteWorkflowsDictionary[update.id];
  }

  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (!old) return;
      outerLoop: for (const page of old.pages) {
        for (const item of page.items) {
          if (!updates.length) break outerLoop;
          const index = updates.findIndex((x) => x.id === item.id);
          if (index > -1) {
            const update = updates.splice(index, 1)[0];
            if (update && !COMPLETE_STATUSES.includes(item.status)) {
              item.status = update.status;

              for (const step of item.steps) {
                const stepMatch = update.steps?.find((x) => x.name === step.name);
                if (stepMatch) {
                  step.status = stepMatch.status;
                  step.completedAt = stepMatch.completedAt;
                  for (const [index, image] of step.images.entries()) {
                    const imageMatch = stepMatch.images.find((x) => x.id === image.id);
                    if (imageMatch) step.images[index] = imageMatch;
                  }
                }
              }
            }
          }
        }
      }
    })
  );
}

async function updateSignaledWorkflows() {
  const signalData = { ...signalStepEventsDictionary };
  signalStepEventsDictionary = {};

  const workflowIds = Object.keys(signalData);
  if (!workflowIds.length) return;

  await updateWorkflowsStatus(workflowIds);
}

export function usePollWorkflows() {
  const interval = useInterval(
    async () => {
      const workflowIds = Object.keys(incompleteWorkflowsDictionary);
      await updateWorkflowsStatus(workflowIds);
    },
    60000,
    { autoInvoke: true }
  );
}
