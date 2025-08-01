import type { DeepPartial } from 'react-hook-form';
import { showNotification } from '@mantine/notifications';
import { uniqBy } from 'lodash-es';
import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';

import * as z from 'zod/v4';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { UsePersistFormReturn } from '~/libs/form/hooks/usePersistForm';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import type { BaseModelSetType } from '~/server/common/constants';
import { constants, generation, getGenerationConfig } from '~/server/common/constants';
import { textToImageParamsSchema } from '~/server/schema/orchestrator/textToImage.schema';
import type {
  GenerationData,
  GenerationResource,
} from '~/server/services/generation/generation.service';
import type { SupportedBaseModel } from '~/shared/constants/generation.constants';
import {
  fluxKreaAir,
  fluxModeOptions,
  fluxModelId,
  fluxStandardAir,
  generationSamplers,
  getBaseModelFromResourcesWithDefault,
  getBaseModelSetType,
  getBaseModelSetTypes,
  getClosestAspectRatio,
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
import type { WorkflowDefinitionType } from '~/server/services/orchestrator/types';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';
import { generationResourceSchema } from '~/server/schema/generation.schema';
import { getModelVersionUsesImageGen } from '~/shared/orchestrator/ImageGen/imageGen.config';
import { promptSimilarity } from '~/utils/prompt-similarity';
import { getIsFluxKontext } from '~/shared/orchestrator/ImageGen/flux1-kontext.config';

// #region [schemas]

type PartialFormData = Partial<z.input<typeof formSchema>>;
// type DeepPartialFormData = DeepPartial<z.input<typeof formSchema>>;
export type GenerationFormOutput = z.infer<typeof formSchema>;
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
  });
const partialSchema = baseSchema.partial();
const formSchema = baseSchema
  .transform(({ ...data }) => {
    const isFluxUltra = getIsFluxUltra({ modelId: data.model.model.id, fluxMode: data.fluxMode });
    const { height, width } = isFluxUltra
      ? getSizeFromFluxUltraAspectRatio(Number(data.fluxUltraAspectRatio))
      : getSizeFromAspectRatio(data.aspectRatio, data.baseModel);

    if (
      data.model.id === fluxModelId &&
      data.fluxMode !== fluxStandardAir &&
      data.fluxMode !== fluxKreaAir
    )
      data.priority = 'low';

    return removeEmpty({
      ...data,
      height,
      width,
    });
  })
  .superRefine((data, ctx) => {
    if (data.workflow.startsWith('txt2img')) {
      if (!data.prompt || data.prompt.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Prompt cannot be empty',
          path: ['prompt'],
        });
      }
    }

    if (data.prompt.length > 1500) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
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

    if (data.prompt.length > 0) {
      const { blockedFor, success } = auditPrompt(data.prompt, data.negativePrompt);
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
          path: ['prompt'],
        });
      }
    }

    if (data.workflow.startsWith('img2img') && !data.sourceImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Image is required',
        path: ['sourceImage'],
      });
    }
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
function formatGenerationData(data: Omit<GenerationData, 'type'>): PartialFormData {
  const { quantity, ...params } = data.params;
  // check for new model in resources, otherwise use stored model
  let checkpoint = data.resources.find((x) => x.model.type === 'Checkpoint');
  let vae = data.resources.find((x) => x.model.type === 'VAE') ?? null;
  const baseModel =
    params.baseModel ??
    getBaseModelFromResourcesWithDefault(
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
    vae = null;

  if (
    params.sampler === 'undefined' ||
    (params.sampler && !(generationSamplers as string[]).includes(params.sampler))
  )
    params.sampler = defaultValues.sampler;

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
  };
}

// #endregion

// #region [Provider]
type GenerationFormProps = Omit<UsePersistFormReturn<typeof formSchema>, 'reset'> & {
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
  // const browsingSettingsAddons = useBrowsingSettingsAddons();

  const getValues = useCallback(
    (storageValues: any): any => {
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
    partialSchema,
    version: 1.4,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues: getValues,
    // values: getValues,
    exclude: ['remixSimilarity', 'remixPrompt', 'remixNegativePrompt'],
    storage: localStorage,
  });

  function checkSimilarity(id: number, prompt?: string) {
    fetchGenerationData({ type: 'image', id }).then((data) => {
      form.setValue(
        'remixSimilarity',
        !!data.params.prompt && !!prompt
          ? promptSimilarity(data.params.prompt, prompt).adjustedCosine
          : undefined
      );
      form.setValue('remixPrompt', data.params.prompt);
      form.setValue('remixNegativePrompt', data.params.negativePrompt);
      // setValues({
      //   remixSimilarity:
      //     !!data.params.prompt && !!prompt
      //       ? calculateAdjustedCosineSimilarities(data.params.prompt, prompt)
      //       : undefined,
      //   remixPrompt: data.params.prompt,
      //   remixNegativePrompt: data.params.negativePrompt,
      // });
    });
  }

  // TODO.Briant - determine a better way to pipe the data into the form
  // #region [effects]
  useEffect(() => {
    if (type === 'image' && storeData) {
      const { runType, remixOfId, resources, params } = storeData;
      if (!params.sourceImage && !params.workflow)
        form.setValue('workflow', params.process ?? 'txt2img');

      const formData = form.getValues();
      switch (runType) {
        case 'replay':
          setValues(formatGenerationData(storeData));
          break;
        case 'remix':
        case 'run':
          const workflowType = formData.workflow?.split('-')?.[0] as WorkflowDefinitionType;
          const workflow = workflowType !== 'txt2img' ? 'txt2img' : formData.workflow;
          const formResources = [
            formData.model,
            ...(formData.resources ?? []),
            formData.vae,
          ].filter(isDefined) as GenerationResource[];

          const data = formatGenerationData({
            params: {
              aspectRatio: formData.aspectRatio,
              ...params,
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
      // handle model change to update baseModel value
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
        const fluxBaseModels: BaseModelSetType[] = ['Flux1', 'Flux1Kontext'];
        if (!!baseModel && !!prevBaseModel) {
          if (fluxBaseModels.includes(baseModel) && !fluxBaseModels.includes(prevBaseModel))
            form.setValue('cfgScale', 3.5);
          // else if (!fluxBaseModels.includes(baseModel) && fluxBaseModels.includes(prevBaseModel))
          //   form.setValue('cfgScale', 7);
        }

        if (
          prevBaseModel === 'Flux1' &&
          baseModel !== 'Flux1' &&
          watchedValues.sampler === 'undefined'
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

      // handle setting flux mode to standard when flux loras are added
      if (
        watchedValues.baseModel === 'Flux1' &&
        !!watchedValues.resources?.length &&
        watchedValues.fluxMode !== fluxStandardAir &&
        watchedValues.fluxMode !== fluxKreaAir
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

  // useEffect(() => {
  //   if (browsingSettingsAddons.settings.generationDefaultValues) {
  //     const { generationDefaultValues } = browsingSettingsAddons.settings;
  //     Object.keys(generationDefaultValues ?? {}).forEach((key) => {
  //       // @ts-ignore
  //       const value = generationDefaultValues[key as keyof generationDefaultValues];
  //       if (value !== undefined) {
  //         form.setValue(key as keyof PartialFormData, value);
  //       }
  //     });
  //   }
  // }, [browsingSettingsAddons, form]);
  // #endregion

  // #region [handlers]
  function setValues(data: PartialFormData) {
    // don't overwrite quantity
    const { quantity, ...params } = data;
    const formData = form.getValues();
    const parsed = partialSchema.parse({ ...formData, ...params });
    const limited = sanitizeTextToImageParams(parsed, status.limits);
    form.reset(limited, { keepDefaultValues: true });
    // for (const [key, value] of Object.entries(limited)) {
    //   form.setValue(key as keyof PartialFormData, value);
    // }
  }

  function getDefaultValues(overrides: PartialFormData): PartialFormData {
    prevBaseModelRef.current = defaultValues.baseModel;
    const sanitized = sanitizeTextToImageParams(
      {
        ...defaultValues,
        // ...(browsingSettingsAddons.settings.generationDefaultValues ?? {}),
        fluxMode: fluxModeOptions[1].value,
        quantity: overrides.quantity ?? defaultValues.quantity,
        // creatorTip: overrides.creatorTip ?? 0.25,
        experimental: overrides.experimental ?? false,
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
