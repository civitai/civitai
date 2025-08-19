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

type CustomWorkflowStepEvent = Omit<WorkflowStepEvent, '$type'> & { $type: 'step' };
const debouncer = createDebouncer(100);
let signalStepEventsDictionary: Record<string, CustomWorkflowStepEvent> = {};
export function useTextToImageSignalUpdate() {
  return useSignalConnection(SignalMessages.TextToImageUpdate, (data: CustomWorkflowStepEvent) => {
    if (data.$type === 'step' && data.status !== 'unassigned')
      signalStepEventsDictionary[data.workflowId] = { ...data };
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

async function updateSignaledWorkflows() {
  const signalData = { ...signalStepEventsDictionary };
  signalStepEventsDictionary = {};

  const workflowIds = Object.keys(signalData);
  if (!workflowIds.length) return;

  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  const workflows = await Promise.all(workflowIds.map(fetchSignaledWorkflow)).then((data) =>
    data.filter(isDefined)
  );
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (!old) return;
      outerLoop: for (const page of old.pages) {
        for (const item of page.items) {
          if (!workflows.length) break outerLoop;
          const index = workflows.findIndex((x) => x.id === item.id);
          if (index > -1) {
            const match = workflows.splice(index, 1)[0];
            if (match) {
              item.status = match.status;
              for (const step of item.steps) {
                const stepMatch = match.steps?.find((x) => x.name === step.name);
                if (stepMatch) {
                  step.images = stepMatch.images;
                  step.status = stepMatch.status;
                  step.completedAt = stepMatch.completedAt;
                }
              }
            }
          }
        }
      }
    })
  );
}
