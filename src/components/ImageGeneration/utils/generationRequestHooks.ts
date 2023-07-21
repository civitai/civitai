import { InfiniteData, useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { GetGenerationRequestsReturn } from '~/server/services/generation/generation.service';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useEffect, useMemo } from 'react';
import { GetGenerationRequestsInput } from '~/server/schema/generation.schema';
import { GenerationRequestStatus, Generation } from '~/server/services/generation/generation.types';
import { useDebouncer } from '~/utils/debouncer';
import { usePrevious } from '@dnd-kit/utilities';
import { isEqual } from 'lodash-es';

export const useGetGenerationRequests = (
  input?: GetGenerationRequestsInput,
  options?: { enabled?: boolean; onError?: (err: unknown) => void }
) => {
  const { data, ...rest } = trpc.generation.getRequests.useInfiniteQuery(input ?? {}, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    ...options,
  });
  const requests = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [], [data]);
  const images = useMemo(
    () =>
      requests
        .filter((x) => x.status !== GenerationRequestStatus.Error)
        .flatMap((x) => x.images ?? []),
    [requests]
  );
  return { data, requests, images, ...rest };
};

export const useUpdateGenerationRequests = () => {
  const queryClient = useQueryClient();
  const queryKey = getQueryKey(trpc.generation.getRequests);

  const setData = (cb: (data?: InfiniteData<GetGenerationRequestsReturn>) => void) => {
    queryClient.setQueriesData({ queryKey, exact: false }, (state) => produce(state, cb));
  };

  return setData;
};

const POLLABLE_STATUSES = [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing];
export const usePollGenerationRequests = (requestsInput: Generation.Request[] = []) => {
  const update = useUpdateGenerationRequests();
  const debouncer = useDebouncer(5000);
  const requestIds = requestsInput
    .filter((x) => POLLABLE_STATUSES.includes(x.status))
    .map((x) => x.id);
  const { requests, refetch } = useGetGenerationRequests(
    {
      requestId: requestIds,
      take: 100,
      status: !requestIds.length ? POLLABLE_STATUSES : undefined,
      detailed: true,
    },
    {
      onError: () => debouncer(refetch),
    }
  );

  useEffect(() => {
    if (requestsInput.some((x) => POLLABLE_STATUSES.includes(x.status))) {
      debouncer(refetch);
    }
  }, [requestsInput]); //eslint-disable-line

  // update requests with newly polled values
  useEffect(() => {
    update((old) => {
      if (!old) return;
      for (const request of requests) {
        for (const page of old.pages) {
          const index = page.items.findIndex((x) => x.id === request.id);
          if (index > -1) {
            page.items[index] = request;
            break;
          }
        }
      }
    });
  }, [requests]) //eslint-disable-line

  return requests.filter((x) => POLLABLE_STATUSES.includes(x.status)).length;
};

export const useCreateGenerationRequest = () => {
  const update = useUpdateGenerationRequests();
  return trpc.generation.createRequest.useMutation({
    onSuccess: (data) => {
      update((old) => {
        if (!old) return;
        old.pages[0].items.unshift(data);
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to generate',
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
      });
    },
  });
};

export const useDeleteGenerationRequest = () => {
  const update = useUpdateGenerationRequests();
  return trpc.generation.deleteRequest.useMutation({
    onSuccess: (_, { id }) => {
      update((data) => {
        if (!data) return;
        for (const page of data.pages) {
          const index = page.items.findIndex((x) => x.id === id);
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
};

const bulkDeleteImagesMutation = trpc.generation.bulkDeleteImages.useMutation;
export const useDeleteGenerationRequestImages = (
  ...args: Parameters<typeof bulkDeleteImagesMutation>
) => {
  const [options] = args;
  const update = useUpdateGenerationRequests();
  return trpc.generation.bulkDeleteImages.useMutation({
    ...options,
    onSuccess: (response, request, context) => {
      update((data) => {
        if (!data) return;
        for (const page of data.pages) {
          for (const item of page.items) {
            for (const id of request.ids) {
              const index = item.images?.findIndex((x) => x.id === id) ?? -1;
              if (index > -1) item.images?.splice(index, 1);
            }
          }
          // if there are requests without images, remove the requests
          page.items = page.items.filter((x) => !!x.images?.length);
        }
      });
      options?.onSuccess?.(response, request, context);
    },
    onError: (error, ...args) => {
      showErrorNotification({
        title: 'Error deleting images',
        error: new Error(error.message),
      });
      options?.onError?.(error, ...args);
    },
  });
};
