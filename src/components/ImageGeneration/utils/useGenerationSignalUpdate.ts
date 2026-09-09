import type { WorkflowStepEvent } from '@civitai/client';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { type InfiniteTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { createDebouncer } from '~/utils/debouncer';
import { queryClient, trpc, trpcVanilla } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import type {
  NormalizedStep,
  WorkflowStatusUpdate,
} from '~/server/services/orchestrator/orchestration-new.service';
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

type SignaledStep = NonNullable<NonNullable<WorkflowStatusUpdate>['steps']>[number];

/** Applies one refetched step onto the cached step in place — `step` is an immer draft. */
export function mergeSignaledStep(
  step: Pick<NormalizedStep, 'status' | 'completedAt' | 'errors' | 'queuePosition' | 'output'>,
  stepMatch: SignaledStep
) {
  step.status = stepMatch.status;
  step.completedAt = stepMatch.completedAt;
  step.errors = stepMatch.errors;
  // Assigned even when undefined: a step that has left the queue reports no queuePosition, and
  // keeping the old one strands a stale position and ETA on the card for the rest of the session.
  step.queuePosition = stepMatch.queuePosition;
  // Merge updated images by id, then append ones the client has not seen. Multi-step workflows
  // (e.g. Wan 2.2 interpolation) start the later step with zero images and only materialize
  // outputs on completion, which a per-index loop drops until reload.
  for (const [index, item] of step.output.entries()) {
    const itemMatch = stepMatch.output.find((x) => x.id === item.id);
    if (itemMatch) step.output[index] = itemMatch;
  }
  const existingIds = new Set(step.output.map((x) => x.id));
  for (const item of stepMatch.output) {
    if (!existingIds.has(item.id)) step.output.push(item);
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
                if (stepMatch) mergeSignaledStep(step, stepMatch);
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

export async function fetchSignaledWorkflow(
  workflowId: string
): Promise<WorkflowStatusUpdate | undefined> {
  return await trpcVanilla.orchestrator.statusUpdate.query({ workflowId });
}
