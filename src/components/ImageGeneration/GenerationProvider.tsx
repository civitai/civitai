import { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';
import { GenerationRequestStatus } from '~/server/common/enums';
import { Generation } from '~/server/services/generation/generation.types';
import { produce } from 'immer';
import {
  updateGenerationRequest,
  useGetGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useDebouncer } from '~/utils/debouncer';
import { GenerationLimits } from '~/server/schema/generation.schema';
import { UserTier } from '~/server/schema/user.schema';

const POLLABLE_STATUSES = [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing];

type GenerationState = {
  queued: {
    id: number;
    complete: number;
    processing: number;
    quantity: number;
    status: GenerationRequestStatus;
  }[];
  latestImage?: Generation.Image & { createdAt: number };
  queueStatus?: GenerationRequestStatus;
  requestLimit: number;
  requestsRemaining: number;
  requestsLoading: boolean;
  canGenerate: boolean;
  userLimits?: GenerationLimits;
  userTier: UserTier;
};

type GenerationStore = ReturnType<typeof createGenerationStore>;
const createGenerationStore = () =>
  createStore<GenerationState>()(
    devtools<GenerationState>(
      () => ({
        queued: [],
        requestLimit: 0,
        requestsRemaining: 0,
        canGenerate: false,
        userTier: 'free',
        requestsLoading: true,
      }),
      { store: 'generation-context' }
    )
  );

const GenerationContext = createContext<GenerationStore | null>(null);
export function useGenerationContext<T>(selector: (state: GenerationState) => T) {
  const store = useContext(GenerationContext);
  if (!store) throw new Error('missing GenerationProvider');
  return useStore(store, selector);
}

export function GenerationProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<GenerationStore>();
  const { connected } = useSignalContext();
  const { requests, isLoading } = useGetGenerationRequests();
  const generationStatus = useGenerationStatus();

  // #region [queue state]
  const [queued, setQueued] = useState<Generation.Request[]>([]);
  const pendingProcessingQueued = requests.filter(
    (request) =>
      POLLABLE_STATUSES.includes(request.status) || queued.some((x) => x.id === request.id)
  );

  const handleSetQueued = (cb: (draft: Generation.Request[]) => void) => setQueued(produce(cb));

  const deleteQueueItem = (id: number) => {
    handleSetQueued((draft) => {
      const index = draft.findIndex((x) => x.id === id);
      if (index > -1) draft.splice(index, 1);
    });
  };

  const setQueueItem = (request: Generation.Request) => {
    handleSetQueued((draft) => {
      const index = draft.findIndex((x) => x.id === request.id);
      if (index > -1) draft[index] = request;
      else draft.push(request);
    });
    if (!POLLABLE_STATUSES.includes(request.status)) {
      setTimeout(() => deleteQueueItem(request.id), 3000);
    }
  };

  useEffect(() => {
    for (const request of pendingProcessingQueued) setQueueItem(request);
    for (const item of queued) {
      if (!requests.find((x) => x.id === item.id)) deleteQueueItem(item.id);
    }
  }, [requests]); // eslint-disable-line
  // #endregion

  // #region [context state]
  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    const { limits, available } = generationStatus;
    const queuedRequests = queued.map((request) => ({
      id: request.id,
      count: request.images?.filter((x) => x.available).length ?? 0,
      complete: request.images?.filter((x) => x.available).length ?? 0,
      processing: request.images?.filter((x) => x.status === 'Started').length ?? 0,
      quantity: request.quantity,
      status: request.status,
    }));

    const queueStatus = queuedRequests.some((x) => x.status === GenerationRequestStatus.Processing)
      ? GenerationRequestStatus.Processing
      : queuedRequests[0]?.status;

    const requestsRemaining = limits.queue - queuedRequests.length;
    const images = queued
      .flatMap(
        (x) =>
          x.images?.map((image) => ({
            ...image,
            createdAt: new Date(x.createdAt).getTime() + (image.duration ?? 0),
          })) ?? []
      )
      .filter((x) => x.available)
      .sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0));

    store.setState((state) => {
      const latestImage = images.find((x) => x.createdAt > (state.latestImage?.createdAt ?? 0));

      return {
        queued: queuedRequests,
        queueStatus,
        latestImage: latestImage ?? state.latestImage,
        requestsRemaining: requestsRemaining > 0 ? requestsRemaining : 0,
        canGenerate: requestsRemaining > 0 && available && !isLoading,
      };
    });
  }, [queued, generationStatus, isLoading]);

  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    const { limits, tier } = generationStatus;
    store.setState({
      requestLimit: limits.quantity,
      userLimits: limits,
      userTier: tier,
    });
  }, [generationStatus]);

  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    store.setState({ requestsLoading: isLoading });
  }, [isLoading]);
  // #endregion

  // #region [polling]
  const pollableIdsRef = useRef<number[]>([]);
  pollableIdsRef.current = pendingProcessingQueued.map((x) => x.id);
  const hasPollableIds = pollableIdsRef.current.length > 0;
  const debouncer = useDebouncer(1000 * 5);
  const pollable = useGetGenerationRequests(
    {
      requestId: pollableIdsRef.current,
      take: 100,
      detailed: true,
    },
    {
      enabled: false,
    }
  );

  useEffect(() => {
    if (!connected)
      debouncer(() => {
        pollableIdsRef.current.length ? pollable.refetch() : undefined;
      });
  }, [connected, hasPollableIds]); // eslint-disable-line

  useEffect(() => {
    updateGenerationRequest((old) => {
      for (const request of requests) {
        for (const page of old.pages) {
          const index = page.items.findIndex((x) => x.id === request.id);
          if (index > -1) {
            const item = page.items[index];
            item.status = request.status;
            item.images = item.images?.map((image) => {
              const match = request.images?.find((x) => x.hash === image.hash);
              if (!match) return image;
              const available = image.available ? image.available : match.available;
              return { ...image, ...match, available };
            });
          }
        }
      }
    });
  }, [pollable.requests]);
  // #endregion

  if (!storeRef.current) storeRef.current = createGenerationStore();

  return (
    <GenerationContext.Provider value={storeRef.current}>{children}</GenerationContext.Provider>
  );
}
