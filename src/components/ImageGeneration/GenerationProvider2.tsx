import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';

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
import type { WorkflowStatus } from '@civitai/client';
import { isDefined } from '~/utils/type-guards';
import { queryClient, trpc } from '~/utils/trpc';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { getQueryKey } from '@trpc/react-query';
import type { WorkflowQuerySchema } from '~/server/schema/orchestrator/workflows.schema';

const POLLABLE_STATUSES: WorkflowStatus[] = ['unassigned', 'preparing', 'scheduled', 'processing'];

const workflowQuery: WorkflowQuerySchema = {
  tags: [WORKFLOW_TAGS.GENERATION],
};

export function GenerationProvider({ children }: { children: React.ReactNode }) {
  const { limits, available } = useGenerationStatus();
  const currentUser = useCurrentUser();
  const { data } = trpc.orchestrator.queryGeneratedImages.useInfiniteQuery(workflowQuery, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    enabled: !!currentUser,
  });

  const queued =
    data?.pages.flatMap((page) =>
      page.items
        .filter((request) => POLLABLE_STATUSES.includes(request.status))
        .map((request) => {
          const images = request.steps
            .flatMap((s) => s.images)
            .sort((a, b) => {
              if (!b.completed) return 1;
              if (!a.completed) return -1;
              return b.completed.getTime() - a.completed.getTime();
            });
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
        })
    ) ?? [];

  const queueStatus = queued.some((x) => x.status === 'processing')
    ? 'processing'
    : queued[0]?.status;

  const requestsRemaining = limits.queue - queued.length;

  return <></>;
}

export function getGenerationContextSnapshot() {
  const data = queryClient.getQueryData(
    getQueryKey(trpc.orchestrator.queryGeneratedImages, workflowQuery)
  );
}
