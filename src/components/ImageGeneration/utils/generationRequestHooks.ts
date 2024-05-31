import { WorkflowEvent, WorkflowStepJobEvent } from '@civitai/client';
import { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SignalMessages } from '~/server/common/enums';
import { TextToImageWorkflowImageMetadataSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { workflowQuerySchema } from '~/server/schema/orchestrator/workflows.schema';
import { NormalizedTextToImageResponse } from '~/server/services/orchestrator';
import { workflowCompletedStatuses } from '~/server/services/orchestrator/constants';
import { getTextToImageRequests } from '~/server/services/orchestrator/textToImage';
import { createDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { deepOmit } from '~/utils/object-helpers';
import { queryClient, trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

type InfiniteTextToImageRequests = InfiniteData<AsyncReturnType<typeof getTextToImageRequests>>;

export function useGetTextToImageRequests(
  input?: z.input<typeof workflowQuerySchema>,
  options?: { enabled?: boolean }
) {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.orchestrator.getTextToImageRequests.useInfiniteQuery(input ?? {}, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    enabled: !!currentUser,
    ...options,
  });
  const flatData = useMemo(
    () =>
      data?.pages.flatMap((x) =>
        (x.items ?? [])
          .map((response) => {
            const images = [...response.images]
              .filter((image) => !response.metadata?.images?.[image.id]?.hidden)
              .sort((a, b) => {
                if (!b.completed) return 1;
                if (!a.completed) return -1;
                return b.completed.getTime() - a.completed.getTime();
              });
            return !!images.length ? { ...response, images } : null;
          })
          .filter(isDefined)
      ) ?? [],
    [data]
  );

  // useEffect(() => console.log({ flatData }), [flatData]);

  return { data: flatData, ...rest };
}

export function useGetTextToImageRequestsImages(input?: z.input<typeof workflowQuerySchema>) {
  const { data, ...rest } = useGetTextToImageRequests(input);
  const images = useMemo(() => data.flatMap((x) => x.images), [data]);
  return { requests: data, images, ...rest };
}

function updateTextToImageRequests(cb: (data: InfiniteTextToImageRequests) => void) {
  const queryKey = getQueryKey(trpc.orchestrator.getTextToImageRequests);
  // const test = queryClient.getQueriesData({ queryKey, exact: false })
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (!old) return;
      cb(old);
    })
  );
}

export function useSubmitTextToImageRequest() {
  return trpc.orchestrator.createTextToImage.useMutation({
    onSuccess: (data) => {
      updateTextToImageRequests((old) => {
        old.pages[0].items.unshift(data);
      });
      updateFromEvents();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to generate',
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
      });
    },
  });
}

export function useDeleteTextToImageRequest() {
  return trpc.orchestrator.deleteWorkflow.useMutation({
    onSuccess: (_, { workflowId }) => {
      updateTextToImageRequests((data) => {
        for (const page of data.pages) {
          const index = page.items.findIndex((x) => x.id === workflowId);
          if (index > -1) page.items.splice(index, 1);
        }
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error deleting request',
        error: new Error(error.message),
      });
    },
  });
}

export function useCancelTextToImageRequest() {
  return trpc.orchestrator.cancelWorkflow.useMutation({
    onSuccess: (_, { workflowId }) => {
      updateTextToImageRequests((old) => {
        for (const page of old.pages) {
          const index = page.items.findIndex((x) => x.id === workflowId);
          if (index > -1) {
            page.items[index].images = page.items[index].images.filter((x) =>
              workflowCompletedStatuses.includes(x.status)
            );
            if (!page.items[index].images.length) page.items.splice(index, 1);
          }
        }
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error cancelling request',
        error: new Error(error.message),
      });
    },
  });
}

export function useUpdateTextToImageWorkflows(options?: { onSuccess?: () => void }) {
  const queryKey = getQueryKey(trpc.orchestrator.getTextToImageRequests);
  const { mutate, isLoading } = trpc.orchestrator.updateManyTextToImageWorkflows.useMutation({
    onSuccess: (_, { workflows }) => {
      updateTextToImageRequests((old) => {
        for (const page of old.pages) {
          for (const item of page.items) {
            const workflow = workflows.find((x) => x.workflowId === item.id);
            if (workflow) {
              item.metadata = { ...item.metadata, ...workflow.metadata };
            }
          }
        }
      });
      options?.onSuccess?.();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'An error occurred',
        error: new Error(error.message),
      });
    },
  });

  function updateWorkflows(
    args: Array<
      {
        workflowId: string;
        imageId: string;
      } & TextToImageWorkflowImageMetadataSchema
    >
  ) {
    const workflows: NormalizedTextToImageResponse[] = [];
    const allQueriesData = queryClient.getQueriesData<InfiniteTextToImageRequests>({
      queryKey,
      exact: false,
    });
    loop: for (const [, queryData] of allQueriesData) {
      for (const page of queryData?.pages ?? []) {
        for (const item of page.items) {
          if (args.some((x) => x.workflowId === item.id)) {
            workflows.push(item);
            if (workflows.length === args.length) break loop;
          }
        }
      }
    }

    const data = args.map((props) => {
      const { workflowId, imageId, hidden, feedback, comments } = props;
      const workflow = workflows.find((x) => x.id === workflowId);
      return produce({ ...workflow?.metadata?.images?.[imageId], workflowId, imageId }, (draft) => {
        if (comments) draft.comments = comments;
        if (hidden) draft.hidden = hidden;
        if (feedback) draft.feedback = draft.feedback !== feedback ? feedback : undefined;
      });
    });

    const workflowData = workflows.map((workflow) => {
      const toUpdate = data.filter((x) => x.workflowId === workflow.id);
      return {
        workflowId: workflow.id,
        imageCount: workflow.images.length,
        metadata: deepOmit({
          ...workflow.metadata,
          images: produce(workflow.metadata?.images ?? {}, (draft) => {
            for (const { imageId, workflowId, ...rest } of toUpdate) {
              draft[imageId] = { ...draft[imageId], ...rest };
            }
          }),
        }),
      };
    });

    mutate({ workflows: workflowData });
  }

  function hideImages(args: Array<{ workflowId: string; imageIds: string[] }>) {
    const data = args
      .map(({ workflowId, imageIds }) =>
        imageIds.map((imageId) => ({ workflowId, imageId, hidden: true }))
      )
      .flat();
    updateWorkflows(data);
  }

  function toggleFeedback(args: {
    workflowId: string;
    imageId: string;
    feedback: 'liked' | 'disliked';
  }) {
    updateWorkflows([args]);
  }

  function addComment(args: { workflowId: string; imageId: string; comments: string }) {
    updateWorkflows([args]);
  }

  return { hideImages, toggleFeedback, addComment, isLoading };
}

// #region [to remove]
// export const useGetGenerationRequests = (
//   input?: GetGenerationRequestsInput,
//   options?: { enabled?: boolean; onError?: (err: unknown) => void }
// ) => {
//   const currentUser = useCurrentUser();
//   const { data, isLoading, ...rest } = trpc.generation.getRequests.useInfiniteQuery(input ?? {}, {
//     getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
//     enabled: !!currentUser,
//     ...options,
//   });
//   const requests = useMemo(
//     () =>
//       data?.pages.flatMap((x) => {
//         const items = !!x ? x.items : [];
//         return items;
//       }) ?? [],
//     [data]
//   );
//   const images = useMemo(() => requests.flatMap((x) => x.images ?? []), [requests]);

//   useEffect(() => {
//     if (!isLoading) updateFromEvents();
//   }, [isLoading]);

//   return { data, requests, images, isLoading: !currentUser ? false : isLoading, ...rest };
// };

// export const updateGenerationRequest = (
//   cb: (data: InfiniteData<GetGenerationRequestsReturn>) => void
// ) => {
//   const queryKey = getQueryKey(trpc.generation.getRequests);
//   queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
//     produce(state, (old?: InfiniteData<GetGenerationRequestsReturn>) => {
//       if (!old) return;
//       cb(old);
//     })
//   );
// };

// export const useDeleteGenerationRequest = () => {
//   return trpc.generation.deleteRequest.useMutation({
//     onSuccess: (_, { id }) => {
//       updateGenerationRequest((data) => {
//         for (const page of data.pages) {
//           const index = page.items.findIndex((x) => x.id === id);
//           if (index > -1) page.items.splice(index, 1);
//         }
//       });
//     },
//     onError: (error) => {
//       showErrorNotification({
//         title: 'Error deleting request',
//         error: new Error(error.message),
//       });
//     },
//   });
// };

// const bulkDeleteImagesMutation = trpc.generation.bulkDeleteImages.useMutation;
// export const useDeleteGenerationRequestImages = (
//   ...args: Parameters<typeof bulkDeleteImagesMutation>
// ) => {
//   const [options] = args;
//   return trpc.generation.bulkDeleteImages.useMutation({
//     ...options,
//     onSuccess: (response, request, context) => {
//       updateGenerationRequest((data) => {
//         for (const page of data.pages) {
//           for (const item of page.items) {
//             for (const id of request.ids) {
//               const index = item.images?.findIndex((x) => x.id === id) ?? -1;
//               if (index > -1) item.images?.splice(index, 1);
//             }
//             if (item.images?.every((x) => x.available))
//               item.status = GenerationRequestStatus.Succeeded;
//           }
//           // if there are requests without images, remove the requests
//           page.items = page.items.filter((x) => {
//             const hasImages = !!x.images?.length;
//             return hasImages;
//           });
//         }
//       });
//       options?.onSuccess?.(response, request, context);
//     },
//     onError: (error, ...args) => {
//       const [variables] = args;
//       showErrorNotification({
//         title: variables.cancelled ? 'Error cancelling request' : 'Error deleting images',
//         error: new Error(error.message),
//       });
//       options?.onError?.(error, ...args);
//     },
//   });
// };
// #endregion

type CustomJobEvent = Omit<WorkflowStepJobEvent, '$type'> & { $type: 'job'; completed?: Date };
type CustomWorkflowEvent = Omit<WorkflowEvent, '$type'> & { $type: 'workflow' };
const debouncer = createDebouncer(100);
const signalJobEventsDictionary: Record<string, CustomJobEvent> = {};
const signalWorkflowEventsDictionary: Record<string, CustomWorkflowEvent> = {};
export function useTextToImageSignalUpdate() {
  return useSignalConnection(
    SignalMessages.TextToImageUpdate,
    (data: CustomJobEvent | CustomWorkflowEvent) => {
      if (data.$type === 'job' && data.jobId) {
        signalJobEventsDictionary[data.jobId] = data;
      } else if (data.$type === 'workflow' && data.workflowId) {
        signalWorkflowEventsDictionary[data.workflowId] = data;
      }

      debouncer(() => updateFromEvents());
    }
  );
}

function updateFromEvents() {
  if (!Object.keys(signalJobEventsDictionary).length) return;

  updateTextToImageRequests((old) => {
    for (const page of old.pages) {
      for (const item of page.items) {
        if (
          !Object.keys(signalJobEventsDictionary).length &&
          !Object.keys(signalWorkflowEventsDictionary).length
        )
          return;

        const workflowEvent = signalWorkflowEventsDictionary[item.id];
        if (workflowEvent) {
          item.status = workflowEvent.status!;
          if (item.status === signalWorkflowEventsDictionary[item.id].status)
            delete signalWorkflowEventsDictionary[item.id];
        }

        for (const image of item.images) {
          if (!image.jobId) continue;
          const signalEvent = signalJobEventsDictionary[image.jobId];
          if (!signalEvent) continue;
          const { status } = signalEvent;
          image.status = signalEvent.status!;
          image.completed = signalEvent.completed;

          if (status === signalJobEventsDictionary[image.jobId].status) {
            delete signalJobEventsDictionary[image.jobId];
            if (!Object.keys(signalJobEventsDictionary).length) break;
          }
        }
      }
    }
  });
}
