import type React from 'react';
import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  generationStatusDefaultMessage,
  generationStatusSchema,
} from '~/server/schema/generation.schema';
import type { GenerationStatusMode } from '~/server/schema/generation.schema';
import type { GateRule } from '~/shared/data-graph/generation/gates';
import type { CivitaiResource, ImageMetaProps } from '~/server/schema/image.schema';
import type { NormalizedWorkflowMetadata } from '~/server/services/orchestrator';
import { removeEmpty } from '~/utils/object-helpers';
import { parseAIR } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isImageMetaOnSite } from '~/server/utils/image-onsite';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type { GenerationResource } from '~/shared/types/generation.types';
import type {
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';

// export const useGenerationFormStore = create<Partial<GenerateFormModel>>()(
//   persist(() => ({}), { name: 'generation-form-2', version: 0 })
// );

// Mirror the public getStatus shape: it strips the moderator-only `updatedBy`
// stamp, so the placeholder must match that stripped shape.
const { updatedBy, ...defaultServiceStatus } = generationStatusSchema.parse({});
export function useGetGenerationStatus() {
  return trpc.generation.getStatus.useQuery(undefined, {
    gcTime: 60,
    placeholderData: defaultServiceStatus,
    trpc: { context: { skipBatch: true } },
  });
}
export const useGenerationStatus = () => {
  const currentUser = useCurrentUser();
  const { data = defaultServiceStatus, isLoading } = useGetGenerationStatus();

  return useMemo(() => {
    const tier = currentUser?.tier ?? 'free';
    const isModerator = currentUser?.isModerator ?? false;
    // Resolve the mode to an effective available/message for THIS user.
    // Moderators always bypass.
    let available = true;
    let message = data.message;
    // `data.available === false` is the legacy fallback: during a rolling deploy
    // an older server may return the boolean-only shape with no `mode`, in which
    // case the mode checks below all miss — honor `available` so we don't fail
    // open and show generation as available when an admin had it disabled.
    const blocked =
      data.mode === 'disabled' ||
      (data.mode === 'memberOnly' && tier === 'free') ||
      (!data.mode && data.available === false);
    if (!isModerator && blocked) {
      available = false;
      message = data.message ?? generationStatusDefaultMessage;
    }
    const limits = data.limits[tier];
    return { ...data, available, message, tier, limits, isLoading };
  }, [data, currentUser, isLoading]);
};

const DEFAULT_GENERATION_CONFIG = {
  unstableResources: [] as number[],
  experimentalEcosystems: [] as string[],
  selfHostedDisabledEcosystems: [] as string[],
  selfHostedMode: 'enabled' as GenerationStatusMode,
  gateRules: [] as GateRule[],
};

/**
 * Returns the dynamic, Redis-backed generator config:
 * - `unstableResources`: model version IDs flagged unstable by the
 *   `resource-gen-availability` cron
 * - `experimentalEcosystems`: ecosystem keys that should show the
 *   "experimental build" alert in the generator UI (unioned with the
 *   static `isEcosystemExperimental` check)
 * - `selfHostedDisabledEcosystems` / `selfHostedMode`: the self-hosted toggle
 * - `gateRules`: the gate rules that apply to this user (audience-filtered
 *   server-side), resolved per-item by the graph nodes
 *
 * Single tRPC query — every generator component that needs any of these
 * fields should call this hook so React Query dedupes the request.
 */
export const useGenerationConfig = () => {
  const { data } = trpc.generation.getGenerationConfig.useQuery(undefined, {
    gcTime: Infinity,
    staleTime: Infinity,
    trpc: { context: { skipBatch: true } },
  });

  // Merge defaults so every field is always present (also guards stale caches
  // from before a field existed). Callers read `useGenerationConfig().<field>`
  // directly — no per-field hooks needed.
  return useMemo(() => ({ ...DEFAULT_GENERATION_CONFIG, ...data }), [data]);
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

export type AttentionEditResult = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

/**
 * Pure function that applies one mod+ArrowUp / mod+ArrowDown attention edit
 * to a plain-text prompt, given the current selection range as character
 * offsets. Returns the new text + selection range, or `null` when the
 * keystroke is a no-op (cursor in whitespace with no surrounding token,
 * malformed weight, etc.).
 *
 * Extracted from `keyupEditAttention` so the same algorithm can drive both
 * the textarea-based `InputPrompt` and the Tiptap-based `InputPromptSnippets`
 * — the latter has no `selectionStart`/`value` setters to mutate, so the
 * editor wrapper does its own char-offset ↔ ProseMirror-position mapping
 * around this function.
 */
export function editPromptAttentionRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  isPlus: boolean
): AttentionEditResult | null {
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

    return true;
  }

  // If the user hasn't selected anything, let's select their current parenthesis block or word
  if (!selectCurrentParenthesisBlock('<', '>') && !selectCurrentParenthesisBlock('(', ')')) {
    selectCurrentWord();
  }

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
      return null;
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
  if (isNaN(weight)) return null;

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

  return { text, selectionStart, selectionEnd };
}

/**
 * Textarea wrapper around `editPromptAttentionRange`. Reads the current
 * value + selection from the target, runs the algorithm, and writes the
 * result back including the new selection range. Returns the new text
 * (matching the legacy contract used by `InputPrompt`).
 */
export function keyupEditAttention(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  const target = event.target as HTMLTextAreaElement;
  if (!(event.metaKey || event.ctrlKey)) return;

  const isPlus = event.key == 'ArrowUp';
  const isMinus = event.key == 'ArrowDown';
  if (!isPlus && !isMinus) return;

  const result = editPromptAttentionRange(
    target.value,
    target.selectionStart,
    target.selectionEnd,
    isPlus
  );
  if (!result) return;

  event.preventDefault();
  target.focus();
  target.value = result.text;
  target.selectionStart = result.selectionStart;
  target.selectionEnd = result.selectionEnd;

  return result.text;
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

export const isMadeOnSite = (meta: ImageMetaProps | null) => isImageMetaOnSite(meta);

export function getStepMeta(step?: {
  params?: Partial<NormalizedWorkflowMetadata['params']>;
  resources?: NormalizedWorkflowMetadata['resources'];
}): any {
  if (!step) return;
  const metaParams = step.params;
  const metaResources = step.resources;
  const civitaiResources = metaResources?.map((args): CivitaiResource => {
    if ('air' in args && typeof args.air === 'string') {
      const { version, type } = parseAIR(args.air);
      return { modelVersionId: version, type, weight: args.strength };
    } else {
      return { modelVersionId: args.id, type: args.model.type, weight: args.strength };
    }
  });
  // remove 'resources' due to property being set on video gen
  const { resources, ...params } = (metaParams ?? {}) as Record<string, unknown> & {
    resources: any;
  };

  return removeEmpty({
    ...params,
    civitaiResources,
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
