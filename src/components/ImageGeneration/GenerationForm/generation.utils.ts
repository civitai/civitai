import type React from 'react';
import { useCallback, useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { generationStatusSchema } from '~/server/schema/generation.schema';
import type { CivitaiResource, ImageMetaProps } from '~/server/schema/image.schema';
import type { WorkflowStepFormatted } from '~/server/services/orchestrator/common';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { parseAIR } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import type {
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';

// export const useGenerationFormStore = create<Partial<GenerateFormModel>>()(
//   persist(() => ({}), { name: 'generation-form-2', version: 0 })
// );

const defaultServiceStatus = generationStatusSchema.parse({});
export function useGetGenerationStatus() {
  return trpc.generation.getStatus.useQuery(undefined, {
    cacheTime: 60,
    placeholderData: defaultServiceStatus,
    trpc: { context: { skipBatch: true } },
  });
}
export const useGenerationStatus = () => {
  const currentUser = useCurrentUser();
  const { data = defaultServiceStatus, isLoading } = useGetGenerationStatus();

  return useMemo(() => {
    if (currentUser?.isModerator) data.available = true; // Always have generation available for mods
    const tier = currentUser?.tier ?? 'free';
    const limits = data.limits[tier];
    return { ...data, tier, limits, isLoading };
  }, [data, currentUser, isLoading]);
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

// TODO - move these somewhere that makes more sense
// export const getBaseModelSet = (baseModel?: string) => {
//   if (!baseModel) return undefined;
//   return Object.entries(baseModelSets).find(
//     ([key, set]) => key === baseModel || set.includes(baseModel as BaseModel)
//   )?.[1];
// };

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

  return text;
}

// const workflowDefinitionKey = 'workflow-definition';
// export function useSelectedWorkflowDefinition(value?: string) {
//   const [selected, setSelected] = useState(value ?? getLocalValue());

//   useEffect(() => {
//     if (value) return;
//     const newValue = getLocalValue();
//     if (value !== newValue) setSelected(newValue);
//   }, [value]);

//   function getLocalValue() {
//     if (typeof window === 'undefined') return 'txt2img';
//     const item = localStorage.getItem(workflowDefinitionKey);
//     return item ?? 'txt2img';
//   }

//   function handleSetSelected(val: string | ((args: string) => string)) {
//     setSelected((selected) => {
//       const value = typeof val === 'string' ? val : val(selected);
//       if (value.startsWith('txt2img')) localStorage.setItem(workflowDefinitionKey, value);
//       return value;
//     });
//   }

//   console.log({ selected });

//   return [selected, handleSetSelected] as const;
// }

export const isMadeOnSite = (meta: ImageMetaProps | null) => {
  if (!meta) return false;
  if ('civitaiResources' in meta) return true;
  if (meta.engine && Object.keys(videoGenerationConfig2).includes(meta.engine as string))
    return true;
  return false;
};

export function getStepMeta(step?: Omit<WorkflowStepFormatted, 'images'>): any {
  if (!step) return;
  const civitaiResources = step?.resources?.map((args): CivitaiResource => {
    if ('air' in args && typeof args.air === 'string') {
      const { version, type } = parseAIR(args.air);
      return { modelVersionId: version, type, weight: args.strength };
    } else {
      return { modelVersionId: args.id, type: args.model.type, weight: args.strength };
    }
  });
  // remove 'resources' due to property being set on video gen
  const { resources, ...params } = step.params as typeof step.params & { resources: any };

  return removeEmpty({
    ...params,
    civitaiResources,
    transformations: step.metadata.transformations,
  });
}

export function ResourceSelectHandler(options?: ResourceSelectOptions) {
  const types = [...(options?.resources ?? [])?.map((x) => x.type)];
  const baseModels = [
    ...new Set(
      (options?.resources ?? [])?.flatMap((x) => [
        ...(x.baseModels ?? []),
        ...(x.partialSupport ?? []),
      ])
    ),
  ];

  async function select({
    title,
    selectSource = 'generation',
    excludedIds = [],
  }: {
    title?: React.ReactNode;
    selectSource?: ResourceSelectSource;
    excludedIds?: number[];
  }) {
    return new Promise<GenerationResource | void>((res, rej) => {
      openResourceSelectModal({
        title,
        options: { ...options, excludeIds: [...(options?.excludeIds ?? []), ...excludedIds] },
        selectSource,
        onClose: () => res(),
        onSelect: (resource) => {
          if (
            selectSource === 'generation' &&
            !resource.canGenerate &&
            resource.substitute?.canGenerate
          ) {
            res({ ...resource, ...resource.substitute });
          } else {
            res(resource);
          }
        },
      });
    });
  }

  function hasMatch(data: GenerationResource) {
    let match = true;
    if (types.length && !types.includes(data.model.type)) match = false;
    else if (baseModels.length && !baseModels.includes(data.baseModel)) match = false;
    return match;
  }

  function getValues(data: GenerationResource[] | null) {
    if (!data) return null;
    return types ? data.filter(hasMatch) : data;
  }

  function getValue(data: GenerationResource | null) {
    if (!data) return null;
    return hasMatch(data) ? data : null;
  }

  return {
    types,
    baseModels,
    select,
    getValues,
    getValue,
  };
}
