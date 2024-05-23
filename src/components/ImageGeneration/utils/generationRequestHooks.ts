import { WorkflowEvent, WorkflowStepJobEvent } from '@civitai/client';
import { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SignalMessages } from '~/server/common/enums';
import {
  workflowIdSchema,
  workflowQuerySchema,
} from '~/server/schema/orchestrator/workflows.schema';
import { getTextToImageRequests } from '~/server/services/orchestrator/textToImage';
import { createDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

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
        (x.items ?? []).map((response) => ({
          ...response,
          images: response.images.sort((a, b) => {
            if (!b.completed) return 1;
            if (!a.completed) return -1;
            return b.completed.getTime() - a.completed.getTime();
          }),
        }))
      ) ?? [],
    [data]
  );
  return { data: flatData, ...rest };
}

export function useGetTextToImageRequestsImages(input?: z.input<typeof workflowQuerySchema>) {
  const { data, ...rest } = useGetTextToImageRequests(input);
  const images = useMemo(() => data.flatMap((x) => x.images), [data]);
  return { requests: data, images, ...rest };
}

function updateTextToImageRequests(
  cb: (data: InfiniteData<AsyncReturnType<typeof getTextToImageRequests>>) => void
) {
  const queryKey = getQueryKey(trpc.orchestrator.getTextToImageRequests);
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteData<AsyncReturnType<typeof getTextToImageRequests>>) => {
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
    onError: (error) => {
      showErrorNotification({
        title: 'Error cancelling request',
        error: new Error(error.message),
      });
    },
  });
}

export function useDeleteTextToImageImages() {
  return;
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
