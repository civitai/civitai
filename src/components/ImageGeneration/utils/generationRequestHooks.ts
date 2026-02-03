import type { WorkflowStepEvent } from '@civitai/client';
import { applyPatch, JsonPatchFactory } from '@civitai/client';
import type { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { cloneDeep } from 'lodash-es';
import { useMemo } from 'react';
import type * as z from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { updateQueries } from '~/hooks/trpcHelpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { GenerationReactType, GenerationSort, SignalMessages } from '~/server/common/enums';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type {
  GeneratedImageStepMetadata,
  TextToImageStepImageMetadata,
} from '~/server/schema/orchestrator/textToImage.schema';
import type {
  PatchWorkflowParams,
  PatchWorkflowStepParams,
  TagsPatchSchema,
  workflowQuerySchema,
} from '~/server/schema/orchestrator/workflows.schema';
import type { NormalizedGeneratedImageStep } from '~/server/services/orchestrator';
import type {
  WorkflowStatusUpdate,
  WorkflowStepFormatted,
} from '~/server/services/orchestrator/common';
import type { queryGeneratedImageWorkflows2 } from '~/server/services/orchestrator/orchestration-new.service';
import type {
  IWorkflow,
  IWorkflowsInfinite,
} from '~/server/services/orchestrator/orchestrator.schema';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { createDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { queryClient, trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { useAppContext } from '~/providers/AppProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { BlobData } from '~/components/ImageGeneration/utils/BlobData';

export type InfiniteTextToImageRequests = InfiniteData<
  AsyncReturnType<typeof queryGeneratedImageWorkflows2>
>;
export type TextToImageSteps = ReturnType<typeof useGetTextToImageRequests>['steps'];

function imageFilter({ step, tags }: { step: NormalizedGeneratedImageStep; tags?: string[] }) {
  return step.images.filter(({ id }) => {
    const imageMeta = step.metadata?.images?.[id];
    if (imageMeta?.hidden) return false;
    if (tags?.includes(WORKFLOW_TAGS.FAVORITE) && !imageMeta?.favorite) return false;
    if (tags?.includes(WORKFLOW_TAGS.FEEDBACK.LIKED) && imageMeta?.feedback !== 'liked')
      return false;
    if (tags?.includes(WORKFLOW_TAGS.FEEDBACK.DISLIKED) && imageMeta?.feedback !== 'disliked')
      return false;
    return true;
  });
}

export function useInvalidateWhatIf() {
  const queryUtils = trpc.useUtils();
  return function () {
    queryUtils.orchestrator.getImageWhatIf.invalidate();
  };
}

export function useGetTextToImageRequests(
  input?: z.input<typeof workflowQuerySchema>,
  options?: { enabled?: boolean; includeTags?: boolean }
) {
  const { domain } = useAppContext();
  const nsfwEnabled = useBrowsingSettings((state) => state.showNsfw);
  const currentUser = useCurrentUser();

  const filters = useFiltersContext((state) => state.generation);

  // Convert marker filter to tags
  const markerTags = useMemo(() => {
    switch (filters.marker) {
      case GenerationReactType.Favorited:
        return [WORKFLOW_TAGS.FAVORITE];
      case GenerationReactType.Liked:
        return [WORKFLOW_TAGS.FEEDBACK.LIKED];
      case GenerationReactType.Disliked:
        return [WORKFLOW_TAGS.FEEDBACK.DISLIKED];
      default:
        return [];
    }
  }, [filters.marker]);

  // Build complete query tags including new filters
  const queryTags = useMemo(() => {
    const baseTags = [
      WORKFLOW_TAGS.GENERATION,
      ...(options?.includeTags === false ? [] : [...markerTags, ...(filters.tags ?? [])]),
      ...(input?.tags ?? []),
    ];

    if (filters.baseModel) baseTags.push(filters.baseModel);
    if (filters.processType) baseTags.push(filters.processType);

    return baseTags;
  }, [
    markerTags,
    filters.tags,
    filters.baseModel,
    filters.processType,
    options?.includeTags,
    input?.tags,
  ]);

  const { data, ...rest } = trpc.orchestrator.queryGeneratedImages.useInfiniteQuery(
    {
      ...input,
      ascending: filters.sort === GenerationSort.Oldest,
      tags: queryTags,
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      excludeFailed: filters.excludeFailed,
    },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      enabled: !!currentUser && options?.enabled,
    }
  );

  const flatData = useMemo(
    () =>
      data?.pages.flatMap((x) =>
        (x.items ?? [])
          .filter((workflow) => {
            if (!!markerTags.length && workflow.tags.every((tag) => !markerTags.includes(tag)))
              return false;
            return true;
          })
          .map((workflow) => {
            const steps = workflow.steps.map((step) => {
              const images = imageFilter({ step, tags: markerTags }).map(
                (image) =>
                  new BlobData({
                    data: image,
                    step: step,
                    allowMatureContent: workflow.allowMatureContent,
                    domain,
                    nsfwEnabled,
                  })
              );
              return { ...step, images };
            });
            return { ...workflow, steps };
          })
      ) ?? [],
    [data, nsfwEnabled, domain, markerTags]
  );

  const steps = useMemo(() => flatData.flatMap((x) => x.steps), [flatData]);
  const images = useMemo(
    () => steps.flatMap((step) => imageFilter({ step, tags: markerTags })),
    [steps, markerTags]
  );

  return { data: flatData, steps, images, ...rest };
}

export function useGetTextToImageRequestsImages(input?: z.input<typeof workflowQuerySchema>) {
  const { data, steps, ...rest } = useGetTextToImageRequests(input);

  return { requests: data, steps, ...rest };
}

function updateTextToImageRequests({
  cb,
  input,
}: {
  cb: (data: InfiniteTextToImageRequests) => void;
  input?: z.input<typeof workflowQuerySchema>;
}) {
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  queryClient.setQueriesData(
    {
      queryKey,
      exact: false,
      predicate: (data: any) => {
        if (input) {
          const queryInput = data.queryKey[1]?.input ?? {};
          for (const key in input) {
            if (queryInput[key] !== (input as any)[key]) return false;
          }
        }
        return true;
      },
    },
    (state) => {
      return produce(state, (old?: InfiniteTextToImageRequests) => {
        if (!old) return;
        cb(old);
      });
    }
  );
}

export function useSubmitCreateImage() {
  return trpc.orchestrator.generateImage.useMutation({
    onSuccess: (data, input) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = data as any;
      updateTextToImageRequests({
        input: { ascending: false },
        cb: (old) => {
          old.pages[0].items.unshift(item);
        },
      });
      updateTextToImageRequests({
        input: { ascending: true },
        cb: (old) => {
          const index = old.pages.length - 1;
          if (!old.pages[index].nextCursor) {
            old.pages[index].items.push(item);
          }
        },
      });
      // updateFromEvents();
    },
    // onError: (error) => {
    //   showErrorNotification({
    //     title: 'Failed to generate',
    //     error: new Error(error.message),
    //     reason: error.message ?? 'An unexpected error occurred. Please try again later.',
    //   });
    // },
  });
}

export function useUpdateWorkflow() {
  return trpc.orchestrator.updateWorkflow.useMutation({
    onSuccess: (response, { workflowId }) => {
      updateTextToImageRequests({
        cb: (data) => {
          for (const page of data.pages) {
            const index = page.items.findIndex((x) => x.id === workflowId);
            if (index > -1) {
              page.items[index] = response as any;
              break;
            }
          }
        },
      });
    },
  });
}

export function useGenerate(args?: { onError?: (e: any) => void }) {
  return trpc.orchestrator.generate.useMutation({
    onSuccess: (data) => {
      updateTextToImageRequests({
        input: { ascending: false },
        cb: (old) => {
          old.pages[0].items.unshift(data as any);
        },
      });
      updateTextToImageRequests({
        input: { ascending: true },
        cb: (old) => {
          const index = old.pages.length - 1;
          if (!old.pages[index].nextCursor) {
            old.pages[index].items.push(data as any);
          }
        },
      });
      // updateFromEvents();
    },
    ...args,
  });
}

export function useGenerateFromGraph(args?: { onError?: (e: any) => void }) {
  return trpc.orchestrator.generateFromGraph.useMutation({
    onSuccess: (data) => {
      updateTextToImageRequests({
        input: { ascending: false },
        cb: (old) => {
          old.pages[0].items.unshift(data);
        },
      });
      updateTextToImageRequests({
        input: { ascending: true },
        cb: (old) => {
          const index = old.pages.length - 1;
          if (!old.pages[index].nextCursor) {
            old.pages[index].items.push(data);
          }
        },
      });
    },
    ...args,
  });
}

export function useGenerateWithCost(cost = 0) {
  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
    accountTypes: buzzSpendTypes,
  });

  const generate = useGenerate();

  return useMemo(() => {
    async function mutateAsync(...args: Parameters<typeof generate.mutate>) {
      conditionalPerformTransaction(cost, async () => {
        return await generate.mutateAsync(...args);
      });
    }

    function mutate(...args: Parameters<typeof generate.mutate>) {
      conditionalPerformTransaction(cost, () => {
        generate.mutate(...args);
      });
    }

    return { ...generate, mutateAsync, mutate };
  }, [cost, generate]);
}

export function useDeleteTextToImageRequest() {
  return trpc.orchestrator.deleteWorkflow.useMutation({
    onSuccess: (_, { workflowId }) => {
      updateTextToImageRequests({
        cb: (data) => {
          for (const page of data.pages) {
            const index = page.items.findIndex((x) => x.id === workflowId);
            if (index > -1) page.items.splice(index, 1);
          }
        },
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

export type UpdateImageStepMetadataArgs = {
  workflowId: string;
  stepName: string;
  images: Record<string, TextToImageStepImageMetadata>;
};

export function useUpdateImageStepMetadata(options?: { onSuccess?: () => void }) {
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  const { mutate, isLoading } = trpc.orchestrator.patch.useMutation({
    onError: async (error) => {
      // Rollback optimistic update by refetching from server
      await queryClient.invalidateQueries({ queryKey, exact: false });
      showErrorNotification({
        title: 'Failed to update image',
        error: new Error(error.message),
      });
    },
  });

  function updateImages(args: Array<UpdateImageStepMetadataArgs>, onError?: () => void) {
    const allQueriesData = queryClient.getQueriesData<IWorkflowsInfinite>({
      queryKey,
      exact: false,
    });

    // add workflows from query cache to an array for quick reference
    const workflows: IWorkflow[] = [];
    loop: for (const [, queryData] of allQueriesData) {
      for (const page of queryData?.pages ?? []) {
        for (const workflow of page.items) {
          const match = args.find((x) => x.workflowId === workflow.id);
          if (match) workflows.push(workflow);
          if (workflows.length === args.length) break loop;
        }
      }
    }

    const workflowPatches: PatchWorkflowParams[] = [];
    const stepPatches: PatchWorkflowStepParams[] = [];
    const updated: UpdateImageStepMetadataArgs[] = [];
    const tags: { workflowId: string; tag: string; op: 'add' | 'remove' }[] = [];
    const toDelete: string[] = [];

    for (const workflow of workflows) {
      const match = args.find((x) => x.workflowId === workflow.id);
      if (!match) continue;
      const { workflowId, stepName, images } = match;
      for (const step of workflow.steps as WorkflowStepFormatted[]) {
        if (step.name !== stepName) continue;
        const metadata = step.metadata ?? {};
        const jsonPatch = new JsonPatchFactory<GeneratedImageStepMetadata>();
        if (!metadata.images) jsonPatch.addOperation({ op: 'add', path: 'images', value: {} });
        for (const imageId in images) {
          if (!metadata.images?.[imageId])
            jsonPatch.addOperation({ op: 'add', path: `images/${imageId}`, value: {} });

          const current = metadata.images?.[imageId] ?? {};
          const { hidden, feedback, comments, postId, favorite } = match.images[imageId];
          if (hidden)
            jsonPatch.addOperation({ op: 'add', path: `images/${imageId}/hidden`, value: true });
          if (feedback) {
            jsonPatch.addOperation({
              op: feedback !== current.feedback ? 'add' : 'remove',
              path: `images/${imageId}/feedback`,
              value: feedback,
            });
          }
          if (comments)
            jsonPatch.addOperation({
              op: 'add',
              path: `images/${imageId}/comments`,
              value: comments,
            });
          if (postId)
            jsonPatch.addOperation({
              op: 'add',
              path: `images/${imageId}/postId`,
              value: postId,
            });
          if (favorite !== undefined) {
            jsonPatch.addOperation({
              op: favorite ? 'add' : 'remove',
              path: `images/${imageId}/favorite`,
              value: true,
            });
          }
        }

        const clone = cloneDeep(metadata);
        applyPatch(clone, jsonPatch.operations);
        const patchedImages = clone.images ?? {};

        // first check if the workflow should be deleted
        const hiddenCount = Object.values(patchedImages).filter((x) => x.hidden).length;
        if (step.images.length === hiddenCount) {
          toDelete.push(workflow.id);
        } else {
          const images = removeEmpty(patchedImages);
          // return transformed data
          updated.push({ workflowId, stepName, images });

          const hasTagFavorite = workflow.tags.includes(WORKFLOW_TAGS.FAVORITE);
          const hasTagLike = workflow.tags.includes(WORKFLOW_TAGS.FEEDBACK.LIKED);
          const hasTagDislike = workflow.tags.includes(WORKFLOW_TAGS.FEEDBACK.DISLIKED);

          const hasFavoriteImages = Object.values(images).some((x) => x.favorite);
          const hasLikedImages = Object.values(images).some((x) => x.feedback === 'liked');
          const hasDislikedImages = Object.values(images).some((x) => x.feedback === 'disliked');

          if (hasTagFavorite && !hasFavoriteImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FAVORITE, op: 'remove' });
          } else if (!hasTagFavorite && hasFavoriteImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FAVORITE, op: 'add' });
          }

          if (hasTagLike && !hasLikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.LIKED, op: 'remove' });
          } else if (!hasTagLike && hasLikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.LIKED, op: 'add' });
          }

          if (hasTagDislike && !hasDislikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.DISLIKED, op: 'remove' });
          } else if (!hasTagDislike && hasDislikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.DISLIKED, op: 'add' });
          }

          stepPatches.push({ workflowId, stepName, patches: jsonPatch.operations });
        }
      }
    }

    // Optimistically update the cache before mutation to ensure UI updates
    // even if the component unmounts (e.g., menu closing)
    updateTextToImageRequests({
      cb: (old) => {
        for (const page of old.pages) {
          page.items = page.items.filter((x) => !toDelete.includes(x.id));
          for (const workflow of page.items) {
            const tagsToAdd = tags.filter((x) => x.workflowId === workflow.id && x.op === 'add');
            const tagsToRemove = tags.filter(
              (x) => x.workflowId === workflow.id && x.op === 'remove'
            );
            for (const tagOp of tagsToAdd) workflow.tags.push(tagOp.tag);
            if (tagsToRemove.length) {
              const tagsToRemoveSet = new Set(tagsToRemove.map((x) => x.tag));
              workflow.tags = workflow.tags.filter((tag) => !tagsToRemoveSet.has(tag));
            }

            const toUpdate = updated.filter((x) => x.workflowId === workflow.id);
            if (!toUpdate.length) continue;

            for (const step of workflow.steps) {
              const images = toUpdate.find((x) => x.stepName === step.name)?.images;
              if (images) step.metadata = { ...step.metadata, images };
            }
          }
        }
      },
    });

    mutate(
      {
        workflows: workflowPatches.length ? workflowPatches : undefined,
        steps: stepPatches.length ? stepPatches : undefined,
        remove: toDelete.length ? toDelete : undefined,
        tags: tags.length ? tags : undefined,
      },
      {
        onSuccess: () => {
          const tagNames = [...new Set(tags.filter((x) => x.op === 'add').map((x) => x.tag))];
          for (const tag of tagNames) {
            const key = getQueryKey(trpc.orchestrator.queryGeneratedImages, { tags: [tag] });
            queryClient.invalidateQueries({ queryKey: key, exact: false });
          }

          options?.onSuccess?.();
        },
        onError: () => {
          onError?.();
        },
      }
    );
  }

  return { updateImages, isLoading };
}

export function usePatchTags() {
  const { mutate, isLoading } = trpc.orchestrator.patch.useMutation();
  function patchTags(tags: TagsPatchSchema[]) {
    mutate({ tags });
  }

  return { patchTags, isLoading };
}

type CustomWorkflowStepEvent = Omit<WorkflowStepEvent, '$type'> & { $type: 'step' };
const debouncer = createDebouncer(100);
let signalStepEventsDictionary: Record<string, CustomWorkflowStepEvent> = {};
export function useTextToImageSignalUpdate() {
  return useSignalConnection(SignalMessages.TextToImageUpdate, (data: CustomWorkflowStepEvent) => {
    if (data.$type === 'step') signalStepEventsDictionary[data.workflowId] = { ...data };
    debouncer(() => updateSignaledWorkflows());
  });
}

async function fetchSignaledWorkflow(
  workflowId: string
): Promise<WorkflowStatusUpdate | undefined> {
  const response = await fetch(`/api/generation/workflows/${workflowId}/status-update`);
  if (response.ok) return await response.json();
  else {
    // TODO - handle errors
  }
}

async function updateSignaledWorkflows() {
  const signalData = { ...signalStepEventsDictionary };
  signalStepEventsDictionary = {};

  const workflowIds = Object.keys(signalData);
  if (!workflowIds.length) return;

  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  const workflows = await Promise.all(workflowIds.map(fetchSignaledWorkflow)).then((data) =>
    data.filter(isDefined)
  );
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (!old) return;
      outerLoop: for (const page of old.pages) {
        for (const item of page.items) {
          if (!workflows.length) break outerLoop;
          const index = workflows.findIndex((x) => x.id === item.id);
          if (index > -1) {
            const match = workflows.splice(index, 1)[0];
            if (match) {
              item.status = match.status;
              for (const step of item.steps) {
                const stepMatch = match.steps?.find((x) => x.name === step.name);
                if (stepMatch) {
                  step.images = stepMatch.images;
                  step.status = stepMatch.status;
                  step.completedAt = stepMatch.completedAt;
                }
              }
            }
          }
        }
      }
    })
  );
}
