import {
  BaseModel,
  BaseModelSetType,
  baseModelSets,
  samplerOffsets,
} from '~/server/common/constants';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isDefined } from '~/utils/type-guards';
import { calculateGenerationBill } from '~/server/common/generation';
import { RunType } from '~/store/generation.store';
import { uniqBy } from 'lodash';
import { GenerateFormModel } from '~/server/schema/generation.schema';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { fullCoverageModelsDictionary } from '~/server/common/constants';

export const useGenerationFormStore = create<Partial<GenerateFormModel>>()(
  persist(() => ({}), { name: 'generation-form-2', version: 0 })
);

export const useTempGenerateStore = create<{
  baseModel?: BaseModelSetType;
  hasResources?: boolean;
  isLCM?: boolean;
}>(() => ({}));

export const useDerivedGenerationState = () => {
  const totalCost = useGenerationFormStore(({ baseModel, aspectRatio, steps, quantity }) =>
    calculateGenerationBill({ baseModel, aspectRatio, steps, quantity })
  );

  const { baseModel, isFullCoverageModel } = useGenerationFormStore(({ model }) => {
    const baseModel = model?.baseModel ? getBaseModelSetKey(model.baseModel) : undefined;
    const isFullCoverageModel = baseModel
      ? fullCoverageModelsDictionary[baseModel]?.some(({ id }) => id === model?.id)
      : false;
    return {
      baseModel,
      isFullCoverageModel,
    };
  });

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

  return {
    totalCost,
    baseModel,
    hasResources,
    trainedWords,
    additionalResourcesCount,
    samplerCfgOffset,
    isSDXL: baseModel === 'SDXL',
    isLCM,
    isFullCoverageModel,
  };
};

export const useGenerationStatus = () => {
  const { data: status, isLoading } = trpc.generation.getStatus.useQuery(undefined, {
    cacheTime: 0,
  });

  return {
    available: isLoading || status?.available,
    message: status?.message,
  };
};

export const getFormData = (type: RunType, data: Partial<GenerateFormModel>) => {
  const formData = useGenerationFormStore.getState();
  switch (type) {
    case 'remix':
    case 'params':
    case 'random':
      return { ...formData, ...data };
    case 'run': {
      const baseModel = data.baseModel as BaseModelSetType | undefined;
      const resources = (formData.resources ?? []).concat(data.resources ?? []);
      const uniqueResources = !!resources.length ? uniqBy(resources, 'id') : undefined;
      const filteredResources = baseModel
        ? uniqueResources?.filter((x) =>
            baseModelSets[baseModel].includes(x.baseModel as BaseModel)
          )
        : uniqueResources;
      const parsedModel = data.model ?? formData.model;
      const [model] = parsedModel
        ? baseModel
          ? [parsedModel].filter((x) => baseModelSets[baseModel].includes(x.baseModel as BaseModel))
          : [parsedModel]
        : [];

      const parsedVae = data.vae ?? formData.vae;
      const [vae] = parsedVae
        ? baseModel
          ? [parsedVae].filter((x) => baseModelSets[baseModel].includes(x.baseModel as BaseModel))
          : [parsedVae]
        : [];

      return {
        ...formData,
        ...data,
        model,
        resources: filteredResources,
        vae,
      };
    }
    default:
      throw new Error(`unhandled RunType: ${type}`);
  }
};

// TODO - move these somewhere that makes more sense
export const getBaseModelSetKey = (baseModel: string) =>
  Object.entries(baseModelSets).find(
    ([key, baseModels]) => key === baseModel || baseModels.includes(baseModel as any)
  )?.[0] as BaseModelSetType | undefined;

export const getBaseModelset = (baseModel: string) =>
  Object.entries(baseModelSets).find(
    ([key, set]) => key === baseModel || set.includes(baseModel as any)
  )?.[1];

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
