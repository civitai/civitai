import { createContext, useContext, useState, useEffect, useRef } from 'react';

import { produce } from 'immer';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { GenerationLimits } from '~/server/schema/generation.schema';
import { UserTier } from '~/server/schema/user.schema';
import {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageResponse,
} from '~/server/services/orchestrator';
import { WorkflowStatus } from '@civitai/client';
import { isDefined } from '~/utils/type-guards';
import { useGenerationStore } from '~/store/generation.store';

const POLLABLE_STATUSES: WorkflowStatus[] = ['unassigned', 'preparing', 'scheduled', 'processing'];

type GenerationState = {
  queued: {
    id: string;
    complete: number;
    processing: number;
    quantity: number;
    status: WorkflowStatus;
  }[]; // Snackbar
  latestImage?: NormalizedGeneratedImage; // Snackbar
  queueStatus?: WorkflowStatus; // Snackbar
  requestLimit: number; // Snackbar
  requestsRemaining: number; // Snackbar
  requestsLoading: boolean; // GenerationForm
  hasGeneratedImages: boolean; // GenerationForm
  canGenerate: boolean; // GenerateButton
  userLimits?: GenerationLimits; // NA
  userTier: UserTier; // Snackbar
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
        hasGeneratedImages: false,
      }),
      { store: 'generation-context' }
    )
  );

const GenerationContext = createContext<GenerationStore | null>(null);

export function useGenerationContextStore() {
  const store = useContext(GenerationContext);
  if (!store) throw new Error('missing GenerationProvider');
  return store;
}

export function useGenerationContext<T>(selector: (state: GenerationState) => T) {
  const store = useGenerationContextStore();
  return useStore(store, selector);
}

export function GenerationProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<GenerationStore>();
  const opened = useGenerationStore((state) => state.opened);
  const {
    data: requests,
    steps,
    images,
    isLoading,
  } = useGetTextToImageRequests(undefined, { enabled: opened, includeTags: false });
  const generationStatus = useGenerationStatus();

  // #region [queue state]
  const [queued, setQueued] = useState<NormalizedGeneratedImageResponse[]>([]);
  const pendingProcessingQueued = requests.filter(
    (request) =>
      POLLABLE_STATUSES.includes(request.status) || queued.some((x) => x.id === request.id)
  );

  const handleSetQueued = (cb: (draft: NormalizedGeneratedImageResponse[]) => void) =>
    setQueued(produce(cb));

  const deleteQueueItem = (id: string) => {
    handleSetQueued((draft) => {
      const index = draft.findIndex((x) => x.id === id);
      if (index > -1) draft.splice(index, 1);
    });
  };

  const setQueueItem = (request: NormalizedGeneratedImageResponse) => {
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
    const queuedRequests = queued.map((request) => {
      const images = request.steps.flatMap((s) => s.images);
      const quantity = request.steps.reduce(
        (acc, step) => acc + (`quantity` in step.params ? step.params.quantity : 1),
        0
      );
      return {
        id: request.id,
        complete: images.filter((x) => x.status === 'succeeded').length,
        processing: images.filter((x) => x.status === 'processing').length,
        quantity: quantity,
        status: request.status,
      };
    });

    const queueStatus = queuedRequests.some((x) => x.status === 'processing')
      ? 'processing'
      : queuedRequests[0]?.status;

    const requestsRemaining = limits.queue - queuedRequests.length;
    const images = steps
      .flatMap((x) =>
        x.images.map((image) => (image.completed ? { ...image, completed: image.completed } : null))
      )
      .filter(isDefined)
      .sort((a, b) => b.completed.getTime() - a.completed.getTime());

    store.setState((state) => {
      const latestImage = images.find(
        (x) => x.completed.getTime() > (state.latestImage?.completed?.getTime() ?? 0)
      );

      return {
        queued: queuedRequests,
        queueStatus,
        latestImage: latestImage ?? state.latestImage,
        requestsRemaining: requestsRemaining > 0 ? requestsRemaining : 0,
        canGenerate: requestsRemaining > 0 && available,
      };
    });
  }, [queued, steps, generationStatus, isLoading]);

  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    const { limits, tier } = generationStatus;
    store.setState({
      requestLimit: limits.queue,
      userLimits: limits,
      userTier: tier,
    });
  }, [generationStatus]);

  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    store.setState({ requestsLoading: isLoading, hasGeneratedImages: images.length > 0 });
  }, [images, isLoading]);
  // #endregion

  if (!storeRef.current) storeRef.current = createGenerationStore();

  return (
    <GenerationContext.Provider value={storeRef.current}>{children}</GenerationContext.Provider>
  );
}
