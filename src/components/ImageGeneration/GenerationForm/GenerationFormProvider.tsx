import { DeepPartial } from 'react-hook-form';
import { showNotification } from '@mantine/notifications';
import { uniqBy } from 'lodash-es';
import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { TypeOf, z } from 'zod';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UsePersistFormReturn, usePersistForm } from '~/libs/form/hooks/usePersistForm';
import {
  BaseModelSetType,
  constants,
  generation,
  getGenerationConfig,
} from '~/server/common/constants';
import { textToImageParamsSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { GenerationData } from '~/server/services/generation/generation.service';
import {
  SupportedBaseModel,
  fluxModeOptions,
  fluxModelId,
  fluxStandardAir,
  getBaseModelFromResources,
  getBaseModelSetType,
  getBaseModelSetTypes,
  getIsFluxUltra,
  getSizeFromAspectRatio,
  getSizeFromFluxUltraAspectRatio,
  sanitizeTextToImageParams,
} from '~/shared/constants/generation.constants';
import {
  fetchGenerationData,
  generationStore,
  useGenerationFormStore,
  useGenerationStore,
} from '~/store/generation.store';
import { useDebouncer } from '~/utils/debouncer';
import { auditPrompt } from '~/utils/metadata/audit';
import { WorkflowDefinitionType } from '~/server/services/orchestrator/types';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';
import { generationResourceSchema } from '~/server/schema/generation.schema';

// #region [schemas]

type PartialFormData = Partial<TypeOf<typeof formSchema>>;
type DeepPartialFormData = DeepPartial<TypeOf<typeof formSchema>>;
export type GenerationFormOutput = TypeOf<typeof formSchema>;
const formSchema = textToImageParamsSchema
  .omit({ aspectRatio: true, width: true, height: true, fluxUltraAspectRatio: true })
  .extend({
    model: generationResourceSchema,
    resources: generationResourceSchema.array().min(0).default([]),
    vae: generationResourceSchema.optional(),
    prompt: z
      .string()
      .nonempty('Prompt cannot be empty')
      .max(1500, 'Prompt cannot be longer than 1500 characters')
      .superRefine((val, ctx) => {
        const { blockedFor, success } = auditPrompt(val);
        if (!success) {
          let message = `Blocked for: ${blockedFor.join(', ')}`;
          const count = blockedRequest.increment();
          const status = blockedRequest.status();
          if (status === 'warned') {
            message += `. If you continue to attempt blocked prompts, your account will be sent for review.`;
          } else if (status === 'notified') {
            message += `. Your account has been sent for review. If you continue to attempt blocked prompts, your generation permissions will be revoked.`;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message,
            params: { count },
          });
        }
      }),
    remixOfId: z.number().optional(),
    remixSimilarity: z.number().optional(),
    remixPrompt: z.string().optional(),
    aspectRatio: z.string(),
    fluxUltraAspectRatio: z.string(),
    fluxUltraRaw: z.boolean().optional(),
  })
  .transform(({ fluxUltraRaw, ...data }) => {
    const isFluxUltra = getIsFluxUltra({ modelId: data.model.model.id, fluxMode: data.fluxMode });
    const { height, width } = isFluxUltra
      ? getSizeFromFluxUltraAspectRatio(Number(data.fluxUltraAspectRatio))
      : getSizeFromAspectRatio(data.aspectRatio, data.baseModel);

    if (data.model.id === fluxModelId && data.fluxMode !== fluxStandardAir) data.priority = 'low';
    if (fluxUltraRaw) data.engine = 'flux-pro-raw';
    else data.engine = undefined;
    return {
      ...data,
      height,
      width,
    };
  });
export const blockedRequest = (() => {
  let instances: number[] = [];
  const updateStorage = () => {
    localStorage.setItem('brc', JSON.stringify(instances));
  };
  const increment = () => {
    instances.push(Date.now());
    updateStorage();
    return instances.length;
  };
  const status = () => {
    const count = instances.length;
    if (count > constants.imageGeneration.requestBlocking.muted) return 'muted';
    if (count > constants.imageGeneration.requestBlocking.notified) return 'notified';
    if (count > constants.imageGeneration.requestBlocking.warned) return 'warned';
    return 'ok';
  };
  if (typeof window !== 'undefined') {
    const storedInstances = JSON.parse(localStorage.getItem('brc') ?? '[]');
    const cutOff = Date.now() - 1000 * 60 * 60 * 24;
    instances = storedInstances.filter((x: number) => x > cutOff);
    updateStorage();
  }

  return {
    status,
    increment,
  };
})();

// #endregion

// #region [data formatter]
const defaultValues = generation.defaultValues;
function formatGenerationData(data: GenerationData): PartialFormData {
  const { quantity, ...params } = data.params;
  // check for new model in resources, otherwise use stored model
  let checkpoint = data.resources.find((x) => x.model.type === 'Checkpoint');
  let vae = data.resources.find((x) => x.model.type === 'VAE');
  const baseModel =
    params.baseModel ??
    getBaseModelFromResources(
      data.resources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
    );

  const config = getGenerationConfig(baseModel);

  // if current checkpoint doesn't match baseModel, set checkpoint based on baseModel config
  if (
    !checkpoint ||
    getBaseModelSetType(checkpoint.baseModel) !== baseModel ||
    !checkpoint.canGenerate
  ) {
    checkpoint = config.checkpoint;
  }
  // if current vae doesn't match baseModel, set vae to undefined
  if (
    !vae ||
    !getBaseModelSetTypes({ modelType: vae.model.type, baseModel: vae.baseModel }).includes(
      baseModel as SupportedBaseModel
    ) ||
    !vae.canGenerate
  )
    vae = undefined;

  if (params.sampler === 'undefined') params.sampler = defaultValues.sampler;

  // filter out any additional resources that don't belong
  // TODO - update filter to use `baseModelResourceTypes` from `generation.constants.ts`
  const resources = data.resources.filter((resource) => {
    if (
      resource.model.type === 'Checkpoint' ||
      resource.model.type === 'VAE' ||
      !resource.canGenerate
    )
      return false;
    const baseModelSetKeys = getBaseModelSetTypes({
      modelType: resource.model.type,
      baseModel: resource.baseModel,
      defaultType: baseModel as SupportedBaseModel,
    });
    return baseModelSetKeys.includes(baseModel as SupportedBaseModel);
  });

  return {
    ...params,
    baseModel,
    model: checkpoint,
    resources,
    vae,
    remixOfId: data.remixOfId,
  };
}

// #endregion

// #region [Provider]
type GenerationFormProps = Omit<UsePersistFormReturn<TypeOf<typeof formSchema>>, 'reset'> & {
  setValues: (data: PartialFormData) => void;
  reset: () => void;
};

const GenerationFormContext = createContext<GenerationFormProps | null>(null);
export function useGenerationForm() {
  const context = useContext(GenerationFormContext);
  if (!context) throw new Error('missing GenerationFormProvider in tree');
  return context;
}

export function GenerationFormProvider({ children }: { children: React.ReactNode }) {
  const storeData = useGenerationStore((state) => state.data);

  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const type = useGenerationFormStore((state) => state.type);

  const getValues = useCallback(
    (storageValues: DeepPartialFormData) => {
      // Ensure we always get similarity accordingly.
      if (storageValues.remixOfId && storageValues.prompt) {
        checkSimilarity(storageValues.remixOfId, storageValues.prompt);
      }

      return getDefaultValues(storageValues);
    },
    [currentUser, status] // eslint-disable-line
  );

  const prevBaseModelRef = useRef<BaseModelSetType | null>();
  const debouncer = useDebouncer(1000);

  const form = usePersistForm('generation-form-2', {
    schema: formSchema,
    version: 1.1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    values: getValues,
    exclude: ['remixSimilarity', 'remixPrompt'],
    storage: localStorage,
  });

  function checkSimilarity(id: number, prompt?: string) {
    fetchGenerationData({ type: 'image', id }).then((data) => {
      if (data.params.prompt && prompt !== undefined) {
        const similarity = calculateAdjustedCosineSimilarities(data.params.prompt, prompt);
        form.setValue('remixSimilarity', similarity);
      }

      form.setValue('remixPrompt', data.params.prompt);
    });
  }

  // TODO.Briant - determine a better way to pipe the data into the form
  // #region [effects]
  useEffect(() => {
    if (type === 'image' && storeData) {
      const { runType, remixOfId, resources, params } = storeData;
      switch (runType) {
        case 'replay':
          setValues(formatGenerationData(storeData));
          // useGenerationFormStore.setState({ sourceImage: storeData.params.image });
          break;
        case 'remix':
        case 'run':
          const formData = form.getValues();
          const workflowType = formData.workflow?.split('-')?.[0] as WorkflowDefinitionType;
          const workflow = workflowType !== 'txt2img' ? 'txt2img' : formData.workflow;
          const formResources = [
            formData.model,
            ...(formData.resources ?? []),
            formData.vae,
          ].filter(isDefined);

          const data = formatGenerationData({
            params: { ...params, workflow },
            remixOfId: runType === 'remix' ? remixOfId : undefined,
            resources:
              runType === 'remix' ? resources : uniqBy([...resources, ...formResources], 'id'),
          });

          const values =
            runType === 'remix' ? data : { ...removeEmpty(data), resources: data.resources };
          // if (values.image) useGenerationFormStore.setState({ sourceImage: values.image });
          setValues(values);
          break;
      }

      if (remixOfId) {
        checkSimilarity(remixOfId, params.prompt);
      }

      if (runType === 'remix' && resources.length && resources.some((x) => !x.canGenerate)) {
        showNotification({
          color: 'yellow',
          title: 'Remix',
          message: 'Some resources used to generate this image are unavailable',
        });
      }
      generationStore.clearData();
    }
  }, [status, currentUser, storeData]); // eslint-disable-line

  useEffect(() => {
    const subscription = form.watch((watchedValues, { name }) => {
      // handle model change to update baseModel value

      if (name !== 'baseModel') {
        if (
          watchedValues.model &&
          getBaseModelSetType(watchedValues.model.baseModel) !== watchedValues.baseModel
        ) {
          form.setValue('baseModel', getBaseModelSetType(watchedValues.model.baseModel));
        }
      }

      if (name === 'baseModel') {
        if (watchedValues.baseModel === 'Flux1' || watchedValues.baseModel === 'SD3') {
          form.setValue('workflow', 'txt2img');
        }
        if (watchedValues.baseModel === 'Flux1' && prevBaseModelRef.current !== 'Flux1') {
          form.setValue('cfgScale', 3.5);
        }

        if (prevBaseModelRef.current === 'Flux1' && watchedValues.baseModel !== 'Flux1') {
          form.setValue('sampler', 'Euler a');
        }
        prevBaseModelRef.current = watchedValues.baseModel;
      }

      // handle selected `workflow` based on presence of `image` value
      if (name === 'image') {
        if (!watchedValues.image && watchedValues.workflow?.startsWith('img2img')) {
          form.setValue('workflow', 'txt2img');
        }
      }

      if (name === 'prompt') {
        const { remixOfId, prompt } = watchedValues;
        if (remixOfId) {
          debouncer(() => {
            checkSimilarity(remixOfId, prompt);
          });
        }
      }

      // handle setting flux mode to standard when flux loras are added
      if (name === 'resources') {
        if (watchedValues.baseModel === 'Flux1' && !!watchedValues.resources?.length) {
          form.setValue('fluxMode', 'urn:air:flux1:checkpoint:civitai:618692@691639');
        }
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);
  // #endregion

  // #region [handlers]
  function setValues(data: PartialFormData) {
    // don't overwrite quantity
    const { quantity, ...params } = data;
    const limited = sanitizeTextToImageParams(params, status.limits);
    for (const [key, value] of Object.entries(limited)) {
      form.setValue(key as keyof PartialFormData, value);
    }
  }

  function getDefaultValues(overrides: DeepPartialFormData): DeepPartialFormData {
    prevBaseModelRef.current = defaultValues.baseModel;
    return sanitizeTextToImageParams(
      {
        ...defaultValues,
        fluxMode: fluxModeOptions[1].value,
        nsfw: overrides.nsfw ?? false,
        quantity: overrides.quantity ?? defaultValues.quantity,
        // creatorTip: overrides.creatorTip ?? 0.25,
        experimental: overrides.experimental ?? false,
      },
      status.limits
    );
  }

  function reset() {
    form.reset(getDefaultValues(form.getValues()));
  }
  // #endregion

  return (
    <GenerationFormContext.Provider value={{ ...form, setValues, reset }}>
      {children}
    </GenerationFormContext.Provider>
  );
}
// #endregion

function cleanText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<(?:\/?p|img|src|=|"|:|\.|\-|_)>/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

function createVocabMap(tokens1: string[], tokens2: string[]): Map<string, number> {
  const vocab = new Set([...tokens1, ...tokens2]);
  const vocabMap = new Map<string, number>();
  Array.from(vocab).forEach((token, index) => {
    vocabMap.set(token, index + 1);
  });
  return vocabMap;
}

function getTokens(tokens: string[], vocabMap: Map<string, number>): number[] {
  return tokens.map((token) => vocabMap.get(token) || -1);
}

function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  let dotProduct = 0,
    normA = 0,
    normB = 0;
  vectorA.forEach((value, index) => {
    const vectorBIndex = vectorB[index] ?? 0;
    dotProduct += value * vectorBIndex;
    normA += value * value;
    normB += vectorBIndex * vectorBIndex;
  });
  const normy = Math.sqrt(normA) * Math.sqrt(normB);
  return normy > 0 ? dotProduct / normy : 0;
}

function calculateAdjustedCosineSimilarities(prompt1: string, prompt2: string): number {
  const tokens1 = cleanText(prompt1);
  const tokens2 = cleanText(prompt2);
  const vocabMap = createVocabMap(tokens1, tokens2);

  const promptTokens1 = getTokens(tokens1, vocabMap);
  const promptTokens2 = getTokens(tokens2, vocabMap);
  const setTokens1 = getTokens(Array.from(new Set(tokens1)), vocabMap);
  const setTokens2 = getTokens(Array.from(new Set(tokens2)), vocabMap);

  const cosSim = cosineSimilarity(promptTokens1, promptTokens2);
  const setCosSim = cosineSimilarity(setTokens1, setTokens2);

  const adjustedCosSim = (cosSim + 1) / 2;
  const adjustedSetCosSim = (setCosSim + 1) / 2;

  return 2 / (1 / adjustedCosSim + 1 / adjustedSetCosSim);
}

function objectSimilarity(obj1: Record<string, unknown>, obj2: Record<string, unknown>) {
  // TODO
}

// Example usage
// const prompt1 =
//   'beautiful lady, (freckles), big smile, brown hazel eyes, Short hair, rainbow color hair, dark makeup, hyperdetailed photography, soft light, head and shoulders portrait, cover';
// const prompt2 =
//   'beautiful lady, (freckles), big smile, brown hazel eyes, Short hair, rainbow color hair, dark makeup, hyperdetailed photography';

// const similarity = calculateAdjustedCosineSimilarities(prompt1, prompt2);
