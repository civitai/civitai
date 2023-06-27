import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { Generation, GenerationRequestStatus } from '~/server/services/generation/generation.types';
import { isEqual } from 'lodash-es';
import { useCallback, useEffect } from 'react';
import { useGetGenerationRequests } from '~/components/ImageGeneration/hooks/useGetGenerationRequests';
import { useDebouncer } from '~/utils/debouncer';

type RequestsDictionary = Record<number, Generation.Request>;

type ImageGenerationState = {
  ids: number[];
  requests: RequestsDictionary;
  feed: Generation.Image[];
  deletedRequests: number[];
  setRequests: (requests: Generation.Request[], isNew?: boolean) => void;
  removeRequest: (id: number) => void;
};

export const useImageGenerationStore = create<ImageGenerationState>()(
  devtools(
    immer((set, get) => ({
      ids: [] as number[],
      requests: {},
      feed: [],
      deletedRequests: [],
      setRequests: (requests, isNew = false) => {
        const deleted = get().deletedRequests;
        set((state) => {
          for (const request of requests) {
            if (deleted.includes(request.id)) break;
            if (!state.requests[request.id]) {
              // add request data
              state.requests[request.id] = request;
              // add image data
              for (const image of request.images ?? []) {
                if (isNew) state.feed.unshift(image);
                else state.feed.push(image);
              }

              if (isNew) state.ids.unshift(request.id);
              else state.ids.push(request.id);
            } else if (!isEqual(state.requests[request.id], request)) {
              state.requests[request.id] = request;
              if (request.status === GenerationRequestStatus.Error)
                state.feed = state.feed.filter((x) => x.requestId !== request.id);
            }
          }
        });
      },
      removeRequest: (id) => {
        set((state) => {
          // remove request
          delete state.requests[id];
          // update ids
          state.ids = state.ids.filter((x) => x !== id);
          // ensure request isn't added again by `setRequests`
          state.deletedRequests.push(id);
          // remove request images from feed
          state.feed = [...state.feed.filter((x) => x.requestId !== id)];
        });
      },
    }))
  )
);

export const useImageGenerationFeed = () => {
  const queueState = useImageGenerationQueue();
  const feed = useImageGenerationStore((state) => state.feed);

  return {
    feed,
    ...queueState,
  };
};

export const useImageGenerationRequest = (id: number) =>
  useImageGenerationStore(useCallback((state) => state.requests[id], [id]));

const POLLABLE_STATUSES = [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing];
export const useImageGenerationQueue = () => {
  const debouncer = useDebouncer(5000);

  // Global store values
  const requests = useImageGenerationStore((state) => state.requests);
  const setRequests = useImageGenerationStore((state) => state.setRequests);
  const requestIds = useImageGenerationStore((state) => state.ids);

  const {
    requests: infiniteRequests,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isRefetching,
    isFetching,
    isError,
  } = useGetGenerationRequests({ take: 10 });

  const { requests: polledRequests, refetch: pollPending } = useGetGenerationRequests(
    {
      take: 100,
      requestId: Object.values(requests)
        .filter((x) => POLLABLE_STATUSES.includes(x.status))
        .map((x) => x.id),
    },
    {
      enabled: false,
      onError: () => {
        debouncer(pollPending);
      },
    }
  );

  // set requests from infinite paging data
  useEffect(() => setRequests(infiniteRequests), [infiniteRequests, setRequests]);

  // debounced polling of pending/processing requests
  useEffect(() => {
    if (Object.values(requests).some((x) => POLLABLE_STATUSES.includes(x.status))) {
      debouncer(pollPending);
    }
  }, [requests, debouncer, pollPending]);

  // update requests dictionary with polled requests
  useEffect(() => setRequests(polledRequests), [polledRequests, setRequests]);

  return {
    infiniteRequests,
    requestIds,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isRefetching,
    isFetching,
    isError,
  };
};
