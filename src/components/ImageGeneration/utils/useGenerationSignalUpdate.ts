import type { WorkflowStepEvent } from '@civitai/client';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import type { InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { createDebouncer } from '~/utils/debouncer';
import { queryClient, trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import type { WorkflowStatusUpdate } from '~/server/services/orchestrator/orchestration-new.service';
import { COMPLETE_STATUSES, POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

type CustomWorkflowStepEvent = Omit<WorkflowStepEvent, '$type'> & { $type: 'step' };
const debouncer = createDebouncer(100);
let signalStepEventsDictionary: Record<string, CustomWorkflowStepEvent> = {};

export const usePollableWorkflowIdsStore = create<{ ids: string[] }>(() => ({ ids: [] }));
export function useTextToImageSignalUpdate() {
  usePollWorkflows();

  return useSignalConnection(SignalMessages.TextToImageUpdate, (data: CustomWorkflowStepEvent) => {
    if (data.$type === 'step' && data.status !== 'unassigned') {
      signalStepEventsDictionary[data.workflowId] = { ...data };
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
    if (!POLLABLE_STATUSES.includes(update.status)) {
      usePollableWorkflowIdsStore.setState(({ ids }) => ({
        ids: ids.filter((id) => id !== update.id),
      }));
    }
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
                  step.errors = stepMatch.errors;
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

function usePollWorkflows() {
  const hasIds = usePollableWorkflowIdsStore(({ ids }) => ids.length > 0);

  const intervalRef = useRef<number | null>(null);
  function handleClearInterval() {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }
  useEffect(() => {
    if (!hasIds) {
      handleClearInterval();
      return;
    }

    if (!intervalRef.current) {
      intervalRef.current = window.setInterval(async () => {
        const ids = usePollableWorkflowIdsStore.getState().ids;
        await updateWorkflowsStatus(ids);
      }, 60000);
    }

    return handleClearInterval;
  }, [hasIds]);
}
