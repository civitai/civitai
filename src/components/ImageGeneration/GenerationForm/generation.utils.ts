import {
  BaseModel,
  BaseModelSetType,
  baseModelSets,
  generation,
  generationConfig,
  getGenerationConfig,
  samplerOffsets,
  draftMode,
} from '~/server/common/constants';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isDefined } from '~/utils/type-guards';
import { RunType } from '~/store/generation.store';
import { uniqBy } from 'lodash';
import {
  GenerateFormModel,
  GenerationRequestTestRunSchema,
  generationStatusSchema,
  SendFeedbackInput,
} from '~/server/schema/generation.schema';
import React, { useMemo, useCallback } from 'react';
import { trpc } from '~/utils/trpc';
import { Generation } from '~/server/services/generation/generation.types';
import { findClosest } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getBaseModelSetKey } from '~/shared/constants/generation.constants';

export const useGenerationFormStore = create<Partial<GenerateFormModel>>()(
  persist(() => ({}), { name: 'generation-form-2', version: 0 })
);

export const useDerivedGenerationState = () => {
  const status = useGenerationStatus();
  const { totalCost, isCalculatingCost, costEstimateError } = useEstimateTextToImageJobCost();

  const selectedResources = useGenerationFormStore(({ resources = [], model }) => {
    return model ? resources.concat([model]).filter(isDefined) : resources.filter(isDefined);
  });
  const { unstableResources: allUnstableResources } = useUnstableResources();

  const { baseModel } = useGenerationFormStore(
    useCallback(
      ({ model }) => {
        const baseModel = model?.baseModel ? getBaseModelSetKey(model.baseModel) : undefined;
        return {
          baseModel,
        };
      },
      [status]
    )
  );

  const hasResources = useGenerationFormStore(
    ({ resources = [], vae }) => [...resources, vae].filter(isDefined).length > 0
  );

  const additionalResourcesCount = useGenerationFormStore(({ resources = [] }) => resources.length);

  const resources = useGenerationFormStore((state) => state.resources);
  const isLCM = useGenerationFormStore(
    (state) =>
      (state.model?.baseModel.includes('LCM') ||
        state.resources?.some((x) => x.baseModel.includes('LCM'))) ??
      false
  );
  const trainedWords = useMemo(
    () => resources?.flatMap((x) => x.trainedWords).filter(isDefined) ?? [],
    [resources]
  );

  const samplerCfgOffset = useGenerationFormStore(({ sampler, cfgScale }) => {
    const castedSampler = sampler as keyof typeof samplerOffsets;
    const samplerOffset = samplerOffsets[castedSampler] ?? 0;
    const cfgOffset = Math.max((cfgScale ?? 0) - 4, 0) * 2;

    return samplerOffset + cfgOffset;
  });

  const unstableResources = useMemo(
    () => selectedResources.filter((x) => allUnstableResources.includes(x.id)),
    [selectedResources, allUnstableResources]
  );

  const draft = useGenerationFormStore((x) => x.draft);

  return {
    totalCost,
    baseModel,
    hasResources,
    trainedWords,
    additionalResourcesCount,
    samplerCfgOffset,
    isSDXL: baseModel === 'SDXL',
    isLCM,
    unstableResources,
    isCalculatingCost,
    draft,
    costEstimateError,
  };
};

const defaultServiceStatus = generationStatusSchema.parse({});
export const useGenerationStatus = () => {
  const currentUser = useCurrentUser();
  const { data } = trpc.generation.getStatus.useQuery(undefined, {
    cacheTime: 60,
    trpc: { context: { skipBatch: true } },
  });

  return useMemo(() => {
    const status = data ?? defaultServiceStatus;
    if (currentUser?.isModerator) status.available = true; // Always have generation available for mods
    const tier = currentUser?.tier ?? 'free';
    const limits = status.limits[tier];

    return { ...status, tier, limits };
  }, [data]);
};

export const useEstimateTextToImageJobCost = () => {
  const status = useGenerationStatus();
  const model = useGenerationFormStore((state) => state.model);
  const baseModel = model?.baseModel ? getBaseModelSetKey(model.baseModel) : undefined;

  const input = useGenerationFormStore(
    useCallback(
      (state) => {
        const { aspectRatio, steps, quantity, sampler, draft, staging } = state;
        if (!status.charge || !baseModel) return null;

        return {
          baseModel: baseModel ?? generation.defaultValues.model.baseModel,
          aspectRatio: aspectRatio ?? generation.defaultValues.aspectRatio,
          steps: steps ?? generation.defaultValues.steps,
          quantity: quantity ?? generation.defaultValues.quantity,
          sampler: sampler ?? generation.defaultValues.sampler,
          staging,
          draft,
        };
      },
      [baseModel, status.charge]
    )
  );

  const {
    data: result,
    isLoading,
    isError,
  } = trpc.generation.estimateTextToImage.useQuery(input as GenerationRequestTestRunSchema, {
    enabled: !!input,
  });

  const totalCost = status.charge
    ? Math.ceil((result?.jobs ?? []).reduce((acc, job) => acc + job.cost, 0))
    : 0;

  return {
    totalCost,
    isCalculatingCost: input ? isLoading : false,
    costEstimateError: !isLoading && isError,
  };
};

export const useUnstableResources = () => {
  const { data: unstableResources = [] } = trpc.generation.getUnstableResources.useQuery(
    undefined,
    {
      cacheTime: Infinity,
      staleTime: Infinity,
      trpc: { context: { skipBatch: true } },
    }
  );

  return {
    unstableResources,
  };
};

export const useUnsupportedResources = () => {
  const queryUtils = trpc.useUtils();

  const { data: unavailableResources = [] } = trpc.generation.getUnavailableResources.useQuery(
    undefined,
    {
      cacheTime: Infinity,
      staleTime: Infinity,
      trpc: { context: { skipBatch: true } },
    }
  );

  const toggleUnavailableResourceMutation = trpc.generation.toggleUnavailableResource.useMutation({
    onSuccess: async () => {
      await queryUtils.generation.getUnavailableResources.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error updating resource availability',
        error: new Error(error.message),
      });
    },
  });
  const handleToggleUnavailableResource = useCallback(
    (id: number) => {
      return toggleUnavailableResourceMutation.mutateAsync({ id });
    },
    [toggleUnavailableResourceMutation]
  );

  return {
    unavailableResources,
    toggleUnavailableResource: handleToggleUnavailableResource,
    toggling: toggleUnavailableResourceMutation.isLoading,
  };
};

export const getFormData = (
  type: RunType,
  { resources = [], params }: Partial<Generation.Data>
) => {
  const state = useGenerationFormStore.getState();
  let formData = { ...state, ...params };

  formData.model = resources.find((x) => x.modelType === 'Checkpoint') ?? formData.model;

  /* baseModel needs to be determined as soon as possible
    if(type === 'run') selected resource determines the baseModel
    else baseModel is based off checkpoint model */
  let baseModel = getBaseModelSetKey(formData.model?.baseModel) ?? 'SD1';
  if (type === 'run') {
    const resource = resources[0];
    const newBaseModel = getBaseModelSetKey(resource.baseModel) ?? baseModel;
    if (resource.modelType === 'Checkpoint' || resource.modelType === 'VAE') {
      baseModel = newBaseModel;
    } else {
      // only use generationConfig for previous and new baseModels
      const config = Object.entries(generationConfig)
        .filter(([key]) => [baseModel, newBaseModel].includes(key as BaseModelSetType))
        .map(([, value]) => value);

      const shouldUpdate = !config.every(({ additionalResourceTypes }) => {
        return additionalResourceTypes.some(({ type, baseModelSet, baseModels }) => {
          if (type !== resource.modelType) return false;
          let allSupportedBaseModels = getBaseModelSet(baseModelSet) ?? [];
          if (baseModels) {
            for (const baseModel of baseModels) {
              allSupportedBaseModels = [
                ...new Set(allSupportedBaseModels.concat(getBaseModelSet(baseModel) ?? [])),
              ];
            }
          }
          return allSupportedBaseModels.includes(resource.baseModel as BaseModel);
        });
      });
      if (shouldUpdate) baseModel = newBaseModel;
    }
  }

  const { additionalResourceTypes, checkpoint } = getGenerationConfig(baseModel);

  // filter out any additional resources that don't belong
  const resourceFilter = (resource: Generation.Resource) => {
    const baseModelSetKey = getBaseModelSetKey(resource.baseModel);
    return additionalResourceTypes.some((x) => {
      const modelTypeMatches = x.type === resource.modelType;
      const baseModelSetMatches = x.baseModelSet === baseModelSetKey;
      const baseModelIncluded = x.baseModels?.includes(resource.baseModel as BaseModel);
      return modelTypeMatches && (baseModelSetMatches || baseModelIncluded);
    });
  };

  if (type === 'run') {
    formData.vae =
      resources.filter((x) => x.modelType === 'VAE').filter(resourceFilter)[0] ?? formData.vae;
    formData.resources = [...(formData.resources ?? []), ...resources]
      .filter((x) => x.modelType !== 'Checkpoint' && x.modelType !== 'VAE')
      .filter(resourceFilter);
  } else if (type === 'remix') {
    formData.vae = resources.find((x) => x.modelType === 'VAE') ?? formData.vae;
    formData.resources = resources
      .filter((x) => x.modelType !== 'Checkpoint' && x.modelType !== 'VAE')
      .filter(resourceFilter);
  }

  if (params) {
    if (params.width || params.height)
      formData.aspectRatio = getClosestAspectRatio(
        params?.width,
        params?.height,
        params?.baseModel
      );
    if (params.sampler)
      formData.sampler = generation.samplers.includes(
        params.sampler as (typeof generation.samplers)[number]
      )
        ? params.sampler
        : undefined;
  }

  // set default model
  const baseModelMatches = getBaseModelSetKey(formData.model?.baseModel) === baseModel;
  if (!baseModelMatches) {
    formData.model = checkpoint;
  }

  const maxValueKeys = Object.keys(generation.maxValues);
  for (const item of maxValueKeys) {
    const key = item as keyof typeof generation.maxValues;
    if (formData[key]) {
      formData[key] = Math.min(formData[key] ?? 0, generation.maxValues[key]);
    }
  }

  if (type !== 'remix') formData = removeEmpty(formData);
  formData.resources = formData.resources?.length
    ? uniqBy(formData.resources, 'id').slice(0, 9)
    : undefined;

  // Look through data for Draft resource.
  // If we find them, toggle draft and remove the resource.
  const isSDXL = baseModel === 'SDXL' || baseModel === 'Pony' || baseModel === 'SDXLDistilled';
  const draftResourceId = draftMode[isSDXL ? 'sdxl' : 'sd1'].resourceId;
  const draftResourceIndex = formData.resources?.findIndex((x) => x.id === draftResourceId) ?? -1;
  if (draftResourceIndex !== -1) {
    formData.draft = true;
    formData.resources?.splice(draftResourceIndex, 1);
  }
  if (isSDXL) formData.clipSkip = 2;

  return {
    ...formData,
    baseModel,
  };
};

export const getClosestAspectRatio = (width?: number, height?: number, baseModel?: string) => {
  width = width ?? (baseModel === 'SDXL' ? 1024 : 512);
  height = height ?? (baseModel === 'SDXL' ? 1024 : 512);
  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  const ratios = aspectRatios.map((x) => x.width / x.height);
  const closest = findClosest(ratios, width / height);
  const index = ratios.indexOf(closest);
  return `${index ?? 0}`;
};

// TODO - move these somewhere that makes more sense
export const getBaseModelSet = (baseModel?: string) => {
  if (!baseModel) return undefined;
  return Object.entries(baseModelSets).find(
    ([key, set]) => key === baseModel || set.includes(baseModel as BaseModel)
  )?.[1];
};

/**
 * Taken from stable-diffusion-webui github repo and modified to fit our needs
 * @see https://github.com/AUTOMATIC1111/stable-diffusion-webui/blob/master/javascript/edit-attention.js
 */
const DELIMETERS = '.,\\/!?%^*;:{}=`~()\r\n\t';
export function keyupEditAttention(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  const target = event.target as HTMLTextAreaElement;
  if (!(event.metaKey || event.ctrlKey)) return;

  const isPlus = event.key == 'ArrowUp';
  const isMinus = event.key == 'ArrowDown';
  if (!isPlus && !isMinus) return;

  let selectionStart = target.selectionStart;
  let selectionEnd = target.selectionEnd;
  let text = target.value;

  function selectCurrentParenthesisBlock(OPEN: string, CLOSE: string) {
    if (selectionStart !== selectionEnd) return false;

    // Find opening parenthesis around current cursor
    const before = text.substring(0, selectionStart);
    let beforeParen = before.lastIndexOf(OPEN);
    if (beforeParen == -1) return false;
    let beforeParenClose = before.lastIndexOf(CLOSE);
    while (beforeParenClose !== -1 && beforeParenClose > beforeParen) {
      beforeParen = before.lastIndexOf(OPEN, beforeParen - 1);
      beforeParenClose = before.lastIndexOf(CLOSE, beforeParenClose - 1);
    }

    // Find closing parenthesis around current cursor
    const after = text.substring(selectionStart);
    let afterParen = after.indexOf(CLOSE);
    if (afterParen == -1) return false;
    let afterParenOpen = after.indexOf(OPEN);
    while (afterParenOpen !== -1 && afterParen > afterParenOpen) {
      afterParen = after.indexOf(CLOSE, afterParen + 1);
      afterParenOpen = after.indexOf(OPEN, afterParenOpen + 1);
    }
    if (beforeParen === -1 || afterParen === -1) return false;

    // Set the selection to the text between the parenthesis
    const parenContent = text.substring(beforeParen + 1, selectionStart + afterParen);
    const lastColon = parenContent.lastIndexOf(':');
    selectionStart = beforeParen + 1;
    selectionEnd = selectionStart + lastColon;
    target.setSelectionRange(selectionStart, selectionEnd);
    return true;
  }

  function selectCurrentWord() {
    if (selectionStart !== selectionEnd) return false;

    // seek backward until to find beggining
    while (!DELIMETERS.includes(text[selectionStart - 1]) && selectionStart > 0) {
      selectionStart--;
    }

    // seek forward to find end
    while (!DELIMETERS.includes(text[selectionEnd]) && selectionEnd < text.length) {
      selectionEnd++;
    }

    target.setSelectionRange(selectionStart, selectionEnd);
    return true;
  }

  // If the user hasn't selected anything, let's select their current parenthesis block or word
  if (!selectCurrentParenthesisBlock('<', '>') && !selectCurrentParenthesisBlock('(', ')')) {
    selectCurrentWord();
  }

  event.preventDefault();

  let closeCharacter = ')';
  let delta = 0.1;

  if (selectionStart > 0 && text[selectionStart - 1] == '<') {
    closeCharacter = '>';
    delta = 0.05;
  } else if (selectionStart == 0 || text[selectionStart - 1] != '(') {
    // do not include spaces at the end
    while (selectionEnd > selectionStart && text[selectionEnd - 1] == ' ') {
      selectionEnd -= 1;
    }
    if (selectionStart == selectionEnd) {
      return;
    }

    text =
      text.slice(0, selectionStart) +
      '(' +
      text.slice(selectionStart, selectionEnd) +
      ':1.0)' +
      text.slice(selectionEnd);

    selectionStart += 1;
    selectionEnd += 1;
  }

  const end = text.slice(selectionEnd + 1).indexOf(closeCharacter) + 1;
  let weight = parseFloat(text.slice(selectionEnd + 1, selectionEnd + 1 + end));
  if (isNaN(weight)) return;

  weight += isPlus ? delta : -delta;
  weight = parseFloat(weight.toPrecision(12));

  if (closeCharacter == ')' && weight === 1) {
    const endParenPos = text.substring(selectionEnd).indexOf(')');
    text =
      text.slice(0, selectionStart - 1) +
      text.slice(selectionStart, selectionEnd) +
      text.slice(selectionEnd + endParenPos + 1);
    selectionStart--;
    selectionEnd--;
  } else {
    text = text.slice(0, selectionEnd + 1) + weight + text.slice(selectionEnd + end);
  }

  target.focus();
  target.value = text;
  target.selectionStart = selectionStart;
  target.selectionEnd = selectionEnd;
}

export const useGenerationQualityFeedback = () => {
  const sendFeedbackMutation = trpc.generation.sendFeedback.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Unable to send feedback',
        error: new Error(error.message),
      });
    },
  });

  const handleSendFeedback = useCallback(
    (payload: SendFeedbackInput) => {
      return sendFeedbackMutation.mutateAsync(payload);
    },
    [sendFeedbackMutation]
  );

  return {
    sendFeedback: handleSendFeedback,
    sending: sendFeedbackMutation.isLoading,
  };
};
