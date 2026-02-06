/**
 * GenerationFormProvider (Legacy)
 *
 * Adapted from civitai GenerationFormProvider.tsx.
 * Uses generation-graph.store.ts instead of generation.store.ts,
 * and mapGraphToLegacyParams to convert incoming data to legacy format.
 */

import { showNotification } from '@mantine/notifications';
import { uniqBy } from 'lodash-es';
import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';

import * as z from 'zod';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { UsePersistFormReturn } from '~/libs/form/hooks/usePersistForm';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { generation, getGenerationConfig } from '~/server/common/constants';
import { textToImageParamsSchema } from '~/server/schema/orchestrator/textToImage.schema';
import type { GenerationResource } from '~/shared/types/generation.types';
import {
  fluxKreaAir,
  fluxModeOptions,
  fluxStandardAir,
  getBaseModelFromResourcesWithDefault,
  getBaseModelSetType,
  getClosestAspectRatio,
  getIsFluxUltra,
  getIsZImageBase,
  getIsZImageTurbo,
  getSizeFromAspectRatio,
  getSizeFromFluxUltraAspectRatio,
  sanitizeTextToImageParams,
} from '~/shared/constants/generation.constants';
import {
  fetchGenerationData,
  generationGraphStore,
  useGenerationGraphStore,
} from '~/store/generation-graph.store';
import { mapGraphToLegacyParams } from '~/server/services/orchestrator/legacy-metadata-mapper';
import { useDebouncer } from '~/utils/debouncer';
import type { WorkflowDefinitionType } from '~/server/services/orchestrator/types';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';
import { generationResourceSchema } from '~/server/schema/generation.schema';
import { getModelVersionUsesImageGen } from '~/shared/orchestrator/ImageGen/imageGen.config';
import { promptSimilarity } from '~/utils/prompt-similarity';
import { getIsFluxKontext } from '~/shared/orchestrator/ImageGen/flux1-kontext.config';
import {
  flux2KleinSampleMethods,
  flux2KleinSchedules,
  getIsFlux2KleinGroup,
} from '~/shared/orchestrator/ImageGen/flux2-klein.config';
import { zImageSampleMethods, zImageSchedules } from '~/shared/orchestrator/ImageGen/zImage.config';
import { getIsQwenImageEditModel } from '~/shared/orchestrator/ImageGen/qwen.config';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';
import { getGenerationBaseModelAssociatedGroups } from '~/shared/constants/base-model.constants';
import { imageAnnotationsSchema } from '~/components/Generation/Input/DrawingEditor/drawing.utils';

// #region [schemas]

// We'll define these types after createFormSchema
type PartialFormData = Partial<z.input<ReturnType<typeof createFormSchema>>>;
export type GenerationFormOutput = z.infer<ReturnType<typeof createFormSchema>>;
const baseSchema = textToImageParamsSchema
  .omit({ aspectRatio: true, width: true, height: true, fluxUltraAspectRatio: true, prompt: true })
  .extend({
    model: generationResourceSchema,
    resources: generationResourceSchema.array().min(0).nullable().default(null),
    vae: generationResourceSchema.nullable().default(null),
    prompt: z.string().default(''),
    remixOfId: z.number().optional(),
    remixSimilarity: z.number().optional(),
    remixPrompt: z.string().optional(),
    remixNegativePrompt: z.string().optional(),
    aspectRatio: z.string(),
    fluxUltraAspectRatio: z.string().optional(),
    fluxUltraRaw: z.boolean().default(false).catch(false),
    imageAnnotations: imageAnnotationsSchema,
  });
const partialSchema = baseSchema.partial();

function createFormSchema(_domainColor: string) {
  return baseSchema
    .transform(({ ...data }) => {
      const isFluxUltra = getIsFluxUltra({ modelId: data.model.model.id, fluxMode: data.fluxMode });
      const { height, width } = isFluxUltra
        ? getSizeFromFluxUltraAspectRatio(Number(data.fluxUltraAspectRatio))
        : getSizeFromAspectRatio(data.aspectRatio, data.baseModel, data.model.id);

      return removeEmpty({
        ...data,
        height,
        width,
      });
    })
    .superRefine((data, ctx) => {
      if (getIsFlux2KleinGroup(data.baseModel)) {
        if (!data.prompt || data.prompt.length === 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'Prompt is required',
            path: ['prompt'],
          });
        }
      } else if (data.workflow.startsWith('txt2img')) {
        const hasAnnotations = data.imageAnnotations && data.imageAnnotations.length > 0;
        if (!hasAnnotations && (!data.prompt || data.prompt.length === 0)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Prompt cannot be empty',
            path: ['prompt'],
          });
        }
      }

      if ((data.baseModel === 'Imagen4' || data.baseModel === 'NanoBanana') && data.quantity > 4) {
        ctx.addIssue({
          code: 'custom',
          message: `${data.baseModel} generation currently only supports a maximum quantity of 4`,
          path: ['model'],
        });
      }

      if (data.prompt.length > 1500) {
        ctx.addIssue({
          code: 'custom',
          message: 'Prompt cannot be longer than 1500 characters',
          path: ['prompt'],
        });
      }

      if (data.negativePrompt && data.negativePrompt.length > 1000) {
        ctx.addIssue({
          code: 'custom',
          message: 'Prompt cannot be longer than 1000 characters',
          path: ['negativePrompt'],
        });
      }

      if (data.workflow.startsWith('img2img') && !data.sourceImage) {
        ctx.addIssue({
          code: 'custom',
          message: 'Image is required',
          path: ['sourceImage'],
        });
      }

      if (getIsQwenImageEditModel(data.model.id) && (!data.images || data.images.length === 0)) {
        ctx.addIssue({
          code: 'custom',
          message: 'At least one image is required for Qwen image editing',
          path: ['images'],
        });
      }
    });
}
// #endregion

// #region [data formatter]
const defaultValues = generation.defaultValues;

interface LegacyGenerationData {
  params: Record<string, unknown>;
  resources: GenerationResource[];
  remixOfId?: number;
}

function formatGenerationData(data: LegacyGenerationData): PartialFormData {
  const { quantity, ...params } = data.params as Record<string, unknown> & { quantity?: number };
  let checkpoint = data.resources.find((x) => x.model.type === 'Checkpoint');
  let vae = data.resources.find((x) => x.model.type === 'VAE') ?? null;
  const baseModel =
    (params.baseModel as string) ??
    getBaseModelFromResourcesWithDefault(
      data.resources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
    );

  const config = getGenerationConfig(baseModel, checkpoint?.id);

  if (
    !checkpoint ||
    getBaseModelSetType(checkpoint.baseModel) !== baseModel ||
    !checkpoint.canGenerate
  ) {
    checkpoint = config.checkpoint;
  }

  if (
    !vae ||
    !getGenerationBaseModelAssociatedGroups(vae.baseModel, vae.model.type).includes(
      baseModel as BaseModelGroup
    ) ||
    !vae.canGenerate
  )
    vae = null;

  if (
    params.sampler === 'undefined' ||
    (params.sampler && !(generation.samplers as string[]).includes(params.sampler as string))
  )
    params.sampler = defaultValues.sampler;

  if (
    getIsFlux2KleinGroup(baseModel) &&
    (!params.sampler || !flux2KleinSampleMethods.includes(params.sampler as any))
  )
    params.sampler = 'euler';

  if (
    getIsFlux2KleinGroup(baseModel) &&
    (!params.scheduler || !flux2KleinSchedules.includes(params.scheduler as any))
  )
    params.scheduler = 'simple';

  if (
    (getIsZImageBase(baseModel) || getIsZImageTurbo(baseModel)) &&
    (!params.sampler || !zImageSampleMethods.includes(params.sampler as any))
  )
    params.sampler = 'euler';

  if (
    (getIsZImageBase(baseModel) || getIsZImageTurbo(baseModel)) &&
    (!params.scheduler || !zImageSchedules.includes(params.scheduler as any))
  )
    params.scheduler = 'simple';

  const resources = data.resources.filter((resource) => {
    if (
      resource.model.type === 'Checkpoint' ||
      resource.model.type === 'VAE' ||
      !resource.canGenerate
    )
      return false;
    const baseModelSetKeys = getGenerationBaseModelAssociatedGroups(
      resource.baseModel,
      resource.model.type
    );
    return baseModelSetKeys.includes(baseModel as BaseModelGroup);
  });

  if (checkpoint?.id && getModelVersionUsesImageGen(checkpoint.id)) {
    if ((params.sourceImage && params.workflow !== 'img2img') || getIsFluxKontext(checkpoint.id))
      params.workflow = 'img2img';
    else if (
      !params.sourceImage &&
      params.workflow !== 'txt2img' &&
      !getIsFluxKontext(checkpoint.id)
    )
      params.workflow = 'txt2img';
  }

  return {
    ...params,
    baseModel,
    model: checkpoint,
    resources,
    vae,
    remixOfId: data.remixOfId,
  } as PartialFormData;
}

// #endregion

// #region [Provider]
type GenerationFormProps = Omit<
  UsePersistFormReturn<ReturnType<typeof createFormSchema>>,
  'reset'
> & {
  setValues: (data: PartialFormData) => void;
  reset: () => void;
};

const GenerationFormContext = createContext<GenerationFormProps | null>(null);
export function useGenerationForm() {
  const context = useContext(GenerationFormContext);
  if (!context) throw new Error('missing GenerationFormProvider in tree');
  return context;
}

export function GenerationFormProvider({
  children,
  debug = false,
}: {
  children: React.ReactNode;
  debug?: boolean;
}) {
  // Use generation-graph.store instead of generation.store
  const storeData = useGenerationGraphStore((state) => state.data);
  const storeCounter = useGenerationGraphStore((state) => state.counter);
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const domainColor = useDomainColor();

  const prevCounterRef = useRef(0);

  const getValues = useCallback(
    (storageValues: any): any => {
      if (storageValues.remixOfId && storageValues.prompt) {
        checkSimilarity(storageValues.remixOfId, storageValues.prompt);
      }
      return getDefaultValues(storageValues);
    },
    [currentUser, status] // eslint-disable-line
  );

  const prevBaseModelRef = useRef<BaseModelGroup | null>();
  const debouncer = useDebouncer(1000);

  const formSchema = createFormSchema(domainColor);

  const form = usePersistForm('generation-form-2', {
    schema: formSchema,
    partialSchema,
    version: 1.4,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues: getValues,
    exclude: ['remixSimilarity', 'remixPrompt', 'remixNegativePrompt'],
    storage: typeof window !== 'undefined' ? localStorage : undefined,
  });

  function checkSimilarity(id: number, prompt?: string) {
    fetchGenerationData({ type: 'image', id }).then((data) => {
      form.setValue(
        'remixSimilarity',
        !!data.params.prompt && !!prompt
          ? promptSimilarity(data.params.prompt as string, prompt).adjustedCosine
          : undefined
      );
      form.setValue('remixPrompt', data.params.prompt as string);
      form.setValue('remixNegativePrompt', data.params.negativePrompt as string);
    });
  }

  useEffect(() => {
    setTimeout(() => {
      setValues(form.getValues());
    }, 0);
  }, []);

  // Listen to generation-graph.store data and convert to legacy format
  useEffect(() => {
    // Only process if counter changed (new data)
    if (storeCounter === prevCounterRef.current || !storeData) return;
    prevCounterRef.current = storeCounter;

    const { runType, remixOfId, resources: graphResources, params: graphParams } = storeData;

    // Legacy form store type sync is handled centrally by syncLegacyFormStore
    // in generation-graph.store.ts (called from setData/open)

    const resources = graphResources as GenerationResource[];

    // Convert graph params to legacy format
    const legacyParams = mapGraphToLegacyParams(graphParams);

    if (!legacyParams.sourceImage && !legacyParams.workflow)
      form.setValue('workflow', (legacyParams.process as string) ?? 'txt2img');

    const formData = form.getValues();
    switch (runType) {
      case 'replay':
        setValues(formatGenerationData({ params: legacyParams, resources, remixOfId }));
        break;
      case 'remix':
      case 'run':
        const workflowType = formData.workflow?.split('-')?.[0] as WorkflowDefinitionType;
        const workflow = workflowType !== 'txt2img' ? 'txt2img' : formData.workflow;
        const formResources = [formData.model, ...(formData.resources ?? []), formData.vae].filter(
          isDefined
        ) as GenerationResource[];

        const data = formatGenerationData({
          params: {
            aspectRatio: formData.aspectRatio,
            ...legacyParams,
            workflow,
          },
          remixOfId: runType === 'remix' ? remixOfId : undefined,
          resources:
            runType === 'remix' ? resources : uniqBy([...resources, ...formResources], 'id'),
        });

        const values =
          runType === 'remix' ? data : { ...removeEmpty(data), resources: data.resources };
        setValues(values);
        break;
    }

    if (remixOfId) {
      checkSimilarity(remixOfId, legacyParams.prompt as string);
    }

    if (runType === 'remix' && resources.length && resources.some((x) => !x.canGenerate)) {
      showNotification({
        color: 'yellow',
        title: 'Remix',
        message: 'Some resources used to generate this image are unavailable',
      });
    }

    // Clear the store data after consuming
    generationGraphStore.clearData();
  }, [storeCounter, storeData]); // eslint-disable-line

  const baseModel = form.watch('baseModel');
  useEffect(() => {
    if (!baseModel) return;
    const formData = form.getValues();
    if (formData.aspectRatio) {
      const [w, h] = formData.aspectRatio.split(':').map(Number);
      const aspectRatio = getClosestAspectRatio(w, h, baseModel);
      if (formData.aspectRatio !== aspectRatio) form.setValue('aspectRatio', aspectRatio);
    }
  }, [baseModel]);

  useEffect(() => {
    const subscription = form.watch((watchedValues, { name }) => {
      const baseModel = watchedValues.baseModel;
      const prevBaseModel = prevBaseModelRef.current;
      const fluxMode = watchedValues.fluxMode;

      if (name === 'fluxMode') {
        if (fluxMode === fluxKreaAir && baseModel !== 'FluxKrea') {
          form.setValue('model', getGenerationConfig('FluxKrea').checkpoint);
        } else if (fluxMode !== fluxKreaAir && baseModel === 'FluxKrea') {
          form.setValue('model', getGenerationConfig('Flux1').checkpoint);
        }
      }

      if (name !== 'baseModel') {
        if (
          watchedValues.model &&
          getBaseModelSetType(watchedValues.model.baseModel) !== watchedValues.baseModel
        ) {
          form.setValue('baseModel', getBaseModelSetType(watchedValues.model.baseModel));
        }
      }

      if (!name || name === 'baseModel') {
        if (
          (watchedValues.baseModel === 'Flux1' || watchedValues.baseModel === 'SD3') &&
          watchedValues.workflow !== 'txt2img'
        ) {
          form.setValue('workflow', 'txt2img');
        }
        const fluxBaseModels: BaseModelGroup[] = ['Flux1', 'Flux1Kontext', 'FluxKrea'];

        if (!!baseModel && !!prevBaseModel) {
          if (fluxBaseModels.includes(baseModel) && !fluxBaseModels.includes(prevBaseModel)) {
            setTimeout(() => {
              form.setValue('cfgScale', 3.5);
              form.setValue('steps', 25);
            }, 0);
          } else if (baseModel === 'ZImageTurbo' && prevBaseModel !== baseModel) {
            setTimeout(() => {
              form.setValue('cfgScale', 1);
              form.setValue('steps', 9);
            }, 0);
          } else if (baseModel === 'ZImageBase' && prevBaseModel !== baseModel) {
            setTimeout(() => {
              form.setValue('cfgScale', 4);
              form.setValue('steps', 20);
              form.setValue('scheduler', 'simple');
            }, 0);
          } else if (baseModel === 'LTXV2' && prevBaseModel !== baseModel) {
            setTimeout(() => {
              form.setValue('steps', 20);
            }, 0);
          } else if (
            (baseModel === 'Flux2Klein_4B' || baseModel === 'Flux2Klein_9B') &&
            prevBaseModel !== baseModel
          ) {
            setTimeout(() => {
              form.setValue('cfgScale', 1);
              form.setValue('steps', 8);
            }, 0);
          } else if (baseModel === 'Qwen' && prevBaseModel !== baseModel) {
            form.setValue('cfgScale', 2.5);
          } else if (
            baseModel !== 'ZImageTurbo' &&
            baseModel !== 'ZImageBase' &&
            baseModel !== 'Qwen' &&
            baseModel !== 'Flux2Klein_4B' &&
            baseModel !== 'Flux2Klein_9B' &&
            !fluxBaseModels.includes(baseModel) &&
            (prevBaseModel === 'ZImageTurbo' ||
              prevBaseModel === 'ZImageBase' ||
              prevBaseModel === 'Flux2Klein_4B' ||
              prevBaseModel === 'Flux2Klein_9B' ||
              fluxBaseModels.includes(prevBaseModel))
          ) {
            setTimeout(() => {
              form.setValue('cfgScale', 7);
              form.setValue('steps', 30);
            }, 0);
          }
        }

        if (
          prevBaseModel === 'Flux1' &&
          baseModel !== 'Flux1' &&
          watchedValues.sampler === 'undefined'
        ) {
          form.setValue('sampler', 'Euler a');
        }

        if (baseModel && getIsFlux2KleinGroup(baseModel)) {
          setTimeout(() => {
            const currentSampler = form.getValues('sampler');
            const currentScheduler = form.getValues('scheduler');
            if (!currentSampler || !flux2KleinSampleMethods.includes(currentSampler as any)) {
              form.setValue('sampler', 'euler');
            }
            if (!currentScheduler || !flux2KleinSchedules.includes(currentScheduler as any)) {
              form.setValue('scheduler', 'simple');
            }
          }, 0);
        }

        if (baseModel && getIsZImageBase(baseModel)) {
          setTimeout(() => {
            const currentSampler = form.getValues('sampler');
            const currentScheduler = form.getValues('scheduler');
            if (!currentSampler || !zImageSampleMethods.includes(currentSampler as any)) {
              form.setValue('sampler', 'euler');
            }
            if (!currentScheduler || !zImageSchedules.includes(currentScheduler as any)) {
              form.setValue('scheduler', 'simple');
            }
          }, 0);
        }

        const wasUsingsdcppSamplers =
          prevBaseModel && (getIsZImageBase(prevBaseModel) || getIsFlux2KleinGroup(prevBaseModel));
        const nowUsingUISamplers =
          baseModel && !getIsZImageBase(baseModel) && !getIsFlux2KleinGroup(baseModel);
        if (
          wasUsingsdcppSamplers &&
          nowUsingUISamplers &&
          watchedValues.sampler &&
          !generation.samplers.includes(watchedValues.sampler as any)
        ) {
          form.setValue('sampler', 'Euler a');
        }

        prevBaseModelRef.current = watchedValues.baseModel;
      }

      if (!name || name === 'prompt') {
        const { remixOfId, prompt } = watchedValues;
        if (remixOfId) {
          debouncer(() => {
            checkSimilarity(remixOfId, prompt);
          });
        }
      }

      if (
        watchedValues.baseModel === 'Flux1' &&
        !!watchedValues.resources?.length &&
        fluxMode !== fluxStandardAir &&
        fluxMode !== fluxKreaAir
      ) {
        form.setValue('fluxMode', fluxStandardAir);
      }

      if (watchedValues.model?.id && getModelVersionUsesImageGen(watchedValues.model.id)) {
        if (watchedValues.sourceImage && watchedValues.workflow !== 'img2img')
          form.setValue('workflow', 'img2img');
        else if (
          !watchedValues.sourceImage &&
          watchedValues.workflow !== 'txt2img' &&
          !getIsFluxKontext(watchedValues.model.id)
        )
          form.setValue('workflow', 'txt2img');
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // #region [handlers]
  function setValues(data: PartialFormData) {
    const { quantity, ...params } = data;
    const formData = form.getValues();
    const parsed = partialSchema.parse({ ...formData, ...params });
    const limited = sanitizeTextToImageParams(parsed, status.limits);
    form.reset(limited, { keepDefaultValues: true });
  }

  function getDefaultValues(overrides: PartialFormData): PartialFormData {
    prevBaseModelRef.current = overrides.baseModel;
    const isMember = currentUser?.isPaidMember ?? false;
    const sanitized = sanitizeTextToImageParams(
      {
        ...defaultValues,
        fluxMode: fluxModeOptions[1].value,
        quantity: overrides.quantity ?? defaultValues.quantity,
        experimental: overrides.experimental ?? false,
        priority: overrides.priority ?? (isMember ? 'normal' : defaultValues.priority),
        outputFormat: overrides.outputFormat ?? defaultValues.outputFormat,
      },
      status.limits
    );

    return sanitized;
  }

  function reset() {
    form.reset(getDefaultValues(form.getValues()), { keepDefaultValues: false });
  }
  // #endregion

  return (
    <GenerationFormContext.Provider value={{ ...form, setValues, reset }}>
      {children}
    </GenerationFormContext.Provider>
  );
}
// #endregion
