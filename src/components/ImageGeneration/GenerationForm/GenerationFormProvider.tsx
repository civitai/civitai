import { DeepPartial } from 'react-hook-form';
import { ModelType } from '@prisma/client';
import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { TypeOf, z } from 'zod';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UsePersistFormReturn, usePersistForm } from '~/libs/form/hooks/usePersistForm';
import {
  BaseModel,
  constants,
  draftMode,
  generation,
  getGenerationConfig,
} from '~/server/common/constants';
import { imageSchema } from '~/server/schema/image.schema';
import {
  textToImageParamsSchema,
  textToImageResourceSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { userTierSchema } from '~/server/schema/user.schema';
import { GenerationData } from '~/server/services/generation/generation.service';
import { getBaseModelSetType, getIsSdxl } from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { useGenerationStore } from '~/store/generation.store';
import { auditPrompt } from '~/utils/metadata/audit';

// #region [schemas]
const extendedTextToImageResourceSchema = textToImageResourceSchema.extend({
  name: z.string(),
  trainedWords: z.string().array().default([]),
  modelId: z.number(),
  modelName: z.string(),
  modelType: z.nativeEnum(ModelType),
  minStrength: z.number().default(-1),
  maxStrength: z.number().default(2),
  covered: z.boolean().optional(),
  baseModel: z.string(),
  image: imageSchema.pick({ url: true }).optional(),
});

type PartialFormData = Partial<TypeOf<typeof formSchema>>;
type DeepPartialFormData = DeepPartial<TypeOf<typeof formSchema>>;
export type GenerationFormOutput = TypeOf<typeof formSchema>;
const formSchema = textToImageParamsSchema.extend({
  tier: userTierSchema,
  model: extendedTextToImageResourceSchema,
  resources: extendedTextToImageResourceSchema.array().min(0).max(9).default([]),
  vae: extendedTextToImageResourceSchema.optional(),
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
function formatGenerationData({
  formData,
  data,
  versionId,
  type,
}: {
  formData: PartialFormData;
  data: GenerationData;
  /** pass the versionId to specify the resource to use when deriving the baseModel */
  versionId?: number;
  type: 'default' | 'run' | 'remix';
}): PartialFormData {
  // check for new model in resources, otherwise use stored model
  let checkpoint = data.resources.find((x) => x.modelType === 'Checkpoint') ?? formData.model;
  let vae = data.resources.find((x) => x.modelType === 'VAE') ?? formData.vae;

  // use versionId to set the resource we want to use to derive the baseModel
  // (ie, a lora is used to derive the baseModel instead of the checkpoint)
  const baseResource = versionId ? data.resources.find((x) => x.id === versionId) : checkpoint;
  const baseModel = getBaseModelSetType(
    baseResource ? baseResource.baseModel : data.params.baseModel ?? formData.baseModel
  );

  const config = getGenerationConfig(baseModel);

  // if current checkpoint doesn't match baseModel, set checkpoint based on baseModel config
  if (getBaseModelSetType(checkpoint?.modelType) !== baseModel) checkpoint = config.checkpoint;
  // if current vae doesn't match baseModel, set vae to undefined
  if (getBaseModelSetType(vae?.modelType) !== baseModel) vae = undefined;
  // filter out any additional resources that don't belong
  const resources = (
    type === 'remix' ? data.resources : [...(formData.resources ?? []), ...data.resources]
  )
    .filter((resource) => {
      if (resource.modelType === 'Checkpoint' || resource.modelType === 'VAE') return false;
      const baseModelSetKey = getBaseModelSetType(resource.baseModel);
      return config.additionalResourceTypes.some((x) => {
        const modelTypeMatches = x.type === resource.modelType;
        const baseModelSetMatches = x.baseModelSet === baseModelSetKey;
        const baseModelIncluded = x.baseModels?.includes(resource.baseModel as BaseModel);
        return modelTypeMatches && (baseModelSetMatches || baseModelIncluded);
      });
    })
    .slice(0, 9);

  const sampler =
    data.params.sampler && generation.samplers.includes(data.params.sampler as any)
      ? data.params.sampler
      : formData.sampler;

  const returnData: PartialFormData = {
    ...formData,
    ...data.params,
    baseModel,
    model: checkpoint,
    resources,
    vae,
    sampler,
  };

  const maxValueKeys = Object.keys(generation.maxValues);
  for (const item of maxValueKeys) {
    const key = item as keyof typeof generation.maxValues;
    if (returnData[key])
      returnData[key] = Math.min(returnData[key] ?? 0, generation.maxValues[key]);
  }

  const isSDXL = getIsSdxl(baseModel);
  if (isSDXL) returnData.clipSkip = 2;

  // Look through data for Draft resource.
  // If we find them, toggle draft and remove the resource.
  const draftResourceId = draftMode[isSDXL ? 'sdxl' : 'sd1'].resourceId;
  const draftResourceIndex = returnData.resources?.findIndex((x) => x.id === draftResourceId) ?? -1;
  if (draftResourceIndex !== -1) {
    returnData.draft = true;
    returnData.resources?.splice(draftResourceIndex, 1);
  }

  return type === 'run' ? removeEmpty(returnData) : returnData;
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

const defaultValues = generation.defaultValues;
export function GenerationFormProvider({ children }: { children: React.ReactNode }) {
  const input = useGenerationStore((state) => state.input);
  const storeData = useGenerationStore((state) => state.data);

  const _form = useRef<GenerationFormProps | null>(null);
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const { data: responseData } = trpc.generation.getGenerationData.useQuery(input!, {
    enabled: input !== undefined,
  });

  const getValues = useCallback(
    (storageValues: DeepPartialFormData) => getDefaultValues(storageValues),
    [currentUser, status] // eslint-disable-line
  );

  const form = usePersistForm('generation-form-2', {
    schema: formSchema,
    version: 0,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    values: getValues,
    exclude: ['tier'],
    storage: localStorage,
  });

  useEffect(() => {
    if (storeData) {
      const { resources, params } = storeData.data;
      const formData: PartialFormData = { ...params };
      if (!!resources?.length) formData.resources = resources;
      setValues(formData);
    } else {
      const runType = !input ? 'default' : input.type === 'modelVersion' ? 'run' : 'remix';
      const formData =
        runType === 'default'
          ? form.getValues()
          : formatGenerationData({
              formData: form.getValues(),
              data: responseData ?? { resources: [], params: {} },
              versionId: input?.type === 'modelVersion' ? input?.id : undefined,
              type: runType,
            });
      setValues(formData);
    }
  }, [responseData, status, currentUser, storeData]); // eslint-disable-line

  function handleUserLimits(data: PartialFormData): PartialFormData {
    if (!status) return data;
    if (data.steps) data.steps = Math.min(data.steps, status.limits.steps);
    if (data.quantity) data.quantity = Math.min(data.quantity, status.limits.quantity);
    return data;
  }

  function getDefaultValues(overrides: DeepPartialFormData): PartialFormData {
    return handleUserLimits({
      ...defaultValues,
      nsfw: overrides.nsfw ?? false,
      quantity: overrides.quantity ?? defaultValues.quantity,
      tier: currentUser?.tier ?? 'free',
    });
  }

  function reset() {
    form.reset(getDefaultValues(form.getValues()));
  }

  function setValues(data: PartialFormData) {
    const limited = handleUserLimits(data);
    for (const [key, value] of Object.entries(limited)) {
      form.setValue(key as keyof PartialFormData, value);
    }
  }

  if (!_form.current) {
    _form.current = { ...form, setValues, reset };
  }

  return (
    <GenerationFormContext.Provider value={{ ...form, setValues, reset }}>
      {children}
    </GenerationFormContext.Provider>
  );
}
// #endregion
