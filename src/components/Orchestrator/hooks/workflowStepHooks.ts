import { QueryKey } from '@tanstack/react-query';
import produce from 'immer';
import { WritableDraft } from 'immer/dist/internal';
import { updateQueries } from '~/hooks/trpcHelpers';
import {
  IWorkflow,
  IWorkflowsInfinite,
  UpdateWorkflowStepParams,
} from '~/server/services/orchestrator/orchestrator.schema';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export function useUpdateWorkflowSteps<TData extends IWorkflowsInfinite>({
  queryKey,
  onSuccess,
}: {
  onSuccess?: () => void;
  queryKey: QueryKey;
}) {
  const { mutate, isLoading } = trpc.orchestrator.steps.update.useMutation({
    onSuccess: (_, { data }) => {
      updateQueries<TData>(queryKey, (old) => {
        for (const page of old.pages) {
          for (const workflow of page.items) {
            for (const step of workflow.steps) {
              const current = data.find(
                (x) => x.workflowId === workflow.id && x.stepName === step.name
              );
              if (current) {
                step.metadata = { ...step.metadata, ...current.metadata };
              }
            }
          }
        }
      });
      onSuccess?.();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to update workflow step',
        error: new Error(error.message),
      });
    },
  });

  function updateSteps<T extends UpdateWorkflowStepParams['metadata']>(
    args: UpdateWorkflowStepParams[],
    cb: (draft: WritableDraft<T>, metadata: T) => void,
    updateType?: 'feedback'
  ) {
    // gets current workflow data from query cache
    const allQueriesData = queryClient.getQueriesData<IWorkflowsInfinite>({
      queryKey,
      exact: false,
    });

    const reduced = args.reduce<Record<string, UpdateWorkflowStepParams[]>>(
      (acc, { $type, workflowId, stepName, metadata }) => {
        if (!acc[workflowId]) acc[workflowId] = [];
        acc[workflowId].push({ $type, workflowId, stepName, metadata });
        return acc;
      },
      {}
    );
    const workflowsToUpdateCount = Object.keys(reduced).length;

    // add workflows from query cache to an array for quick reference
    const workflows: IWorkflow[] = [];
    loop: for (const [, queryData] of allQueriesData) {
      for (const page of queryData?.pages ?? []) {
        for (const workflow of page.items) {
          const match = reduced[workflow.id];
          if (match) workflows.push(workflow);
          if (workflows.length === workflowsToUpdateCount) break loop;
        }
      }
    }

    // get updated metadata values
    const data = args
      .map(({ $type, workflowId, stepName, metadata }) => {
        const workflow = workflows.find((x) => x.id === workflowId);
        const step = workflow?.steps.find((x) => x.name === stepName);

        // this step should have all the currently cached step metadata
        if (step) {
          return {
            $type,
            workflowId,
            stepName,
            metadata: produce(
              (step.metadata ?? {}) as UpdateWorkflowStepParams['metadata'],
              (draft) => cb(draft as any, metadata as any)
            ),
          };
        }
      })
      .filter(isDefined);

    mutate({ data, updateType });
  }

  return { updateSteps, isLoading };
}
