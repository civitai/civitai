import { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { GetGenerationRequestsReturn } from '~/server/services/generation/generation.service';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';
import { useEffect, useMemo } from 'react';
import { GetGenerationRequestsInput } from '~/server/schema/generation.schema';
import { createDebouncer, useDebouncer } from '~/utils/debouncer';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages, GenerationRequestStatus } from '~/server/common/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  JobStatus,
  JobType,
  TextToImageEvent,
  textToImageEventSchema,
} from '~/libs/orchestrator/jobs';
import { z } from 'zod';
import { isDefined } from '~/utils/type-guards';

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

  return { data, requests, images, isLoading, ...rest };
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
      showErrorNotification({
        title: 'Error deleting images',
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
        if (data.type === JobStatus.Deleted) {
          signalEvents = signalEvents.filter((x) => x.jobId !== data.jobId);
        } else {
          debouncer(() => updateFromEvents());
          signalEvents.push(data);
        }
      }
    }
  );
}

let signalEvents: TextToImageEvent[] = [];
function updateFromEvents() {
  let events = [...signalEvents];
  if (!events.length) return;
  // let toProcess = events.length;

  updateGenerationRequest((old) => {
    pages: for (const page of old.pages) {
      for (const item of page.items) {
        let hasEvents = false;

        for (const image of item.images ?? []) {
          const imageEvents = events.filter((x) => x.jobId === image.hash);
          if (imageEvents.length) hasEvents = true;

          for (const event of imageEvents) {
            const { type, jobDuration } = event;
            if (type === JobStatus.Claimed) image.status = 'Started';
            else if (type === JobStatus.Failed || type === JobStatus.Rejected)
              image.status = 'Error';
            else if (type === JobStatus.Succeeded) image.status = 'Success';

            image.type = type;
            if (image.status === 'Success') {
              image.duration = jobDuration
                ? new TimeSpan(jobDuration).totalMilliseconds
                : undefined;
              image.available = true;
            }
            events = events.filter((x) => x.jobId !== image.hash && x.type === type);
            signalEvents = signalEvents.filter((x) => x.jobId !== image.hash && x.type === type);
          }
        }

        if (hasEvents) {
          const types = item.images?.map((x) => x.type).filter(isDefined) ?? [];
          if (types.length) {
            if (types.some((status) => status === JobStatus.Claimed))
              item.status = GenerationRequestStatus.Processing;
            else if (types.some((status) => status === JobStatus.Failed))
              item.status = GenerationRequestStatus.Error;
            else if (types.every((status) => status === JobStatus.Succeeded))
              item.status = GenerationRequestStatus.Succeeded;
          }

          item.images = item.images?.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
          if (!events.length) break pages;
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
