import { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  JobStatus,
  JobType,
  TextToImageEvent,
  textToImageEventSchema,
} from '~/libs/orchestrator/jobs';
import { GenerationRequestStatus, SignalMessages } from '~/server/common/enums';
import { GetGenerationRequestsInput } from '~/server/schema/generation.schema';
import { GetGenerationRequestsReturn } from '~/server/services/generation/generation.service';
import { Generation } from '~/server/services/generation/generation.types';
import { createDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

export const useGetGenerationRequests = (
  input?: GetGenerationRequestsInput,
  options?: { enabled?: boolean; onError?: (err: unknown) => void }
) => {
  const currentUser = useCurrentUser();
  const { data, isLoading, ...rest } = trpc.generation.getRequests.useInfiniteQuery(input ?? {}, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    enabled: !!currentUser,
    ...options,
  });
  const requests = useMemo(
    () =>
      data?.pages.flatMap((x) => {
        const items = !!x ? x.items : [];
        return items;
      }) ?? [],
    [data]
  );
  const images = useMemo(() => requests.flatMap((x) => x.images ?? []), [requests]);

  useEffect(() => {
    if (!isLoading) updateFromEvents();
  }, [isLoading]);

  return { data, requests, images, isLoading: !currentUser ? false : isLoading, ...rest };
};

export const updateGenerationRequest = (
  cb: (data: InfiniteData<GetGenerationRequestsReturn>) => void
) => {
  const queryKey = getQueryKey(trpc.generation.getRequests);
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteData<GetGenerationRequestsReturn>) => {
      if (!old) return;
      cb(old);
    })
  );
};

export const useCreateGenerationRequest = () => {
  return trpc.generation.createRequest.useMutation({
    onSuccess: (data) => {
      updateGenerationRequest((old) => {
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
};

export const useDeleteGenerationRequest = () => {
  return trpc.generation.deleteRequest.useMutation({
    onSuccess: (_, { id }) => {
      updateGenerationRequest((data) => {
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
  return trpc.generation.bulkDeleteImages.useMutation({
    ...options,
    onSuccess: (response, request, context) => {
      updateGenerationRequest((data) => {
        for (const page of data.pages) {
          for (const item of page.items) {
            for (const id of request.ids) {
              const index = item.images?.findIndex((x) => x.id === id) ?? -1;
              if (index > -1) item.images?.splice(index, 1);
            }
            if (item.images?.every((x) => x.available))
              item.status = GenerationRequestStatus.Succeeded;
          }
          // if there are requests without images, remove the requests
          page.items = page.items.filter((x) => {
            const hasImages = !!x.images?.length;
            return hasImages;
          });
        }
      });
      options?.onSuccess?.(response, request, context);
    },
    onError: (error, ...args) => {
      const [variables] = args;
      showErrorNotification({
        title: variables.cancelled ? 'Error cancelling request' : 'Error deleting images',
        error: new Error(error.message),
      });
      options?.onError?.(error, ...args);
    },
  });
};

const debouncer = createDebouncer(100);
export function useTextToImageSignalUpdate() {
  return useSignalConnection(
    SignalMessages.OrchestratorUpdate,
    (data: z.infer<typeof textToImageEventSchema>) => {
      if (data.jobType === JobType.TextToImage) {
        if (JobStatus) signalEventsDictionary[data.jobId] = data;
        debouncer(() => updateFromEvents());
      }
    }
  );
}

const signalEventsDictionary: Record<string, TextToImageEvent> = {};

const jobStatusMap: Partial<Record<JobStatus, Generation.ImageStatus>> = {
  [JobStatus.Claimed]: 'Started',
  [JobStatus.Deleted]: 'Cancelled',
  [JobStatus.Canceled]: 'Cancelled',
  [JobStatus.Failed]: 'Error',
  [JobStatus.Rejected]: 'Error',
  [JobStatus.Succeeded]: 'Success',
};

function updateFromEvents() {
  if (!Object.keys(signalEventsDictionary).length) return;

  updateGenerationRequest((old) => {
    for (const page of old.pages) {
      for (const item of page.items) {
        if (!Object.keys(signalEventsDictionary).length) return;
        let hasEvents = false;

        for (const image of item.images ?? []) {
          // Get the event
          const event = signalEventsDictionary[image.hash];
          if (!event) continue;
          hasEvents = true;

          // Update status
          const { type, jobDuration } = event;
          const imageStatus = jobStatusMap[type];
          if (imageStatus) image.status = imageStatus;

          // If we finished, track the time it took and mark it ready
          if (image.status === 'Success') {
            image.duration = jobDuration ? new TimeSpan(jobDuration).totalMilliseconds : undefined;
            image.available = true;
          }

          // If the event status is still the same, let's delete it
          if (type === signalEventsDictionary[image.hash]?.type) {
            delete signalEventsDictionary[image.hash];
            if (!Object.keys(signalEventsDictionary).length) break;
          }
        }

        // Update item status
        if (hasEvents) {
          const statuses = item.images?.map((x) => x.status) ?? [];

          if (statuses.some((status) => status === 'Started'))
            item.status = GenerationRequestStatus.Processing;
          else if (statuses.some((status) => status === 'Error'))
            item.status = GenerationRequestStatus.Error;
          else if (statuses.every((status) => status === 'Success'))
            item.status = GenerationRequestStatus.Succeeded;
          else if (statuses.every((status) => status === 'Cancelled'))
            item.status = GenerationRequestStatus.Cancelled;

          item.images = item.images?.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
        }
      }
    }
  });
}

class TimeSpan {
  ticks: number;

  constructor(value: string) {
    const [t = 0, s = 0, m = 0, h = 0, d = 0] = value
      .split(/[.\:]/g)
      .reverse()
      .map((x) => {
        const number = Number(x);
        return !isNaN(number) ? number : 0;
      });

    this.ticks =
      t + (s * 1000 + m * 1000 * 60 + h * 1000 * 60 * 60 + d * 1000 * 60 * 60 * 24) * 10000;
  }

  get totalMilliseconds() {
    return Math.floor(this.ticks / 10000);
  }
}
