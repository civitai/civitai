import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { GenerationRequestStatus } from '~/server/common/enums';
import { Generation } from '~/server/services/generation/generation.types';
import { produce } from 'immer';
import {
  useGetGenerationRequests,
  usePollGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';

const POLLABLE_STATUSES = [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing];

type GenerationState = {
  queued: { id: number; count: number; quantity: number; status: GenerationRequestStatus }[];
  queueStatus: GenerationRequestStatus;
  requestLimit: number;
  requestsRemaining: number;
};

const GenerationContext = createContext<GenerationState | null>(null);
export function useGenerationContext() {
  const context = useContext(GenerationContext);
  if (!context) throw new Error('missing QueueStatsProvider');
  return context;
}

export function GenerationProvider({ children }: { children: React.ReactNode }) {
  const { requests } = useGetGenerationRequests();
  const { isFreeTier, limits } = useGenerationStatus();
  const pendingProcessingCount = usePollGenerationRequests(requests);
  const [queued, setQueued] = useState<Generation.Request[]>([]);

  const deleteQueueItem = (id: number) => {
    setQueued(
      produce((draft) => {
        const index = draft.findIndex((x) => x.id === id);
        if (index > -1) draft.splice(index, 1);
      })
    );
  };

  const setQueueItem = (request: Generation.Request) => {
    setQueued(
      produce((draft) => {
        const index = draft.findIndex((x) => x.id === request.id);
        if (index > -1) draft[index] = request;
        else draft.push(request);
      })
    );
    if (!POLLABLE_STATUSES.includes(request.status)) {
      setTimeout(() => deleteQueueItem(request.id), 3000);
    }
  };

  useEffect(() => {
    const pendingProcessingQueued = requests.filter(
      (request) =>
        POLLABLE_STATUSES.includes(request.status) || queued.some((x) => x.id === request.id)
    );
    for (const request of pendingProcessingQueued) setQueueItem(request);
    for (const item of queued) {
      if (!requests.find((x) => x.id === item.id)) deleteQueueItem(item);
    }
  }, [requests]);

  const state = useMemo(() => {
    const queuedRequests = queued.map((request) => ({
      id: request.id,
      count: request.images?.filter((x) => x.available).length ?? 0,
      quantity: request.quantity,
      status: request.status,
    }));

    const queueStatus = queuedRequests.some((x) => x.status === GenerationRequestStatus.Processing)
      ? GenerationRequestStatus.Processing
      : queuedRequests[0]?.status;

    const requestsRemaining = queuedRequests.length - limits.queue;

    console.log({
      queued: queuedRequests,
      queueStatus,
      requestLimit: limits.quantity,
      requestsRemaining: requestsRemaining > 0 ? requestsRemaining : 0,
    });

    return {
      queued: queuedRequests,
      queueStatus,
      requestLimit: limits.quantity,
      requestsRemaining: requestsRemaining > 0 ? requestsRemaining : 0,
    };
  }, [queued, pendingProcessingCount]);

  return <GenerationContext.Provider value={state}>{children}</GenerationContext.Provider>;
}
