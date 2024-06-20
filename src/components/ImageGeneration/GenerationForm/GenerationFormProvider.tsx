import { DeepPartial } from 'react-hook-form';
import { ModelType } from '@prisma/client';
import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { TypeOf, z } from 'zod';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UsePersistFormReturn, usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { BaseModel, constants, generation, getGenerationConfig } from '~/server/common/constants';
import { imageSchema } from '~/server/schema/image.schema';
import {
  textToImageParamsSchema,
  textToImageResourceSchema,
  textToImageStepMetadataSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { userTierSchema } from '~/server/schema/user.schema';
import { GenerationData } from '~/server/services/generation/generation.service';
import {
  getBaseModelSetType,
  sanitizeTextToImageParams,
} from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { useGenerationStore } from '~/store/generation.store';
import { auditPrompt } from '~/utils/metadata/audit';
import { defaultsByTier } from '~/server/schema/generation.schema';

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
const formSchema = textToImageParamsSchema
  .extend({
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
    metadata: textToImageStepMetadataSchema.optional(),
  })
  .refine(
    (data) => {
      // Check if resources are at limit based on tier
      const { resources, tier } = data;
      const limit = defaultsByTier[tier].resources;

      return resources.length <= limit;
    },
    { message: `You have exceed the number of allowed resources`, path: ['resources'] }
  );

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
  let checkpoint = data.resources.find((x) => x.modelType === 'Checkpoint');
  let vae = data.resources.find((x) => x.modelType === 'VAE');

  // use versionId to set the resource we want to use to derive the baseModel
  // (ie, a lora is used to derive the baseModel instead of the checkpoint)
  const baseResource = checkpoint ?? data.resources[0];
  const baseModel = getBaseModelSetType(
    baseResource ? baseResource.baseModel : data.params.baseModel
  );

  const config = getGenerationConfig(baseModel);

  // if current checkpoint doesn't match baseModel, set checkpoint based on baseModel config
  if (getBaseModelSetType(checkpoint?.modelType) !== baseModel) checkpoint = config.checkpoint;
  // if current vae doesn't match baseModel, set vae to undefined
  if (getBaseModelSetType(vae?.modelType) !== baseModel) vae = undefined;
  // filter out any additional resources that don't belong
  const resources = data.resources
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

  return {
    ...params,
    baseModel,
    model: checkpoint,
    resources,
    vae,
    metadata: data.metadata,
    ...data.metadata?.params,
  };
}

// #endregion

// #region [Provider]
type GenerationFormProps = Omit<UsePersistFormReturn<TypeOf<typeof formSchema>>, 'reset'> & {
  setValues: (data: PartialFormData) => void;
  reset: () => void;
  // metadata?: {
  //   remix?: {
  //     imageId?: number;
  //     versionId?: number;
  //   };
  // };
};

const GenerationFormContext = createContext<GenerationFormProps | null>(null);
export function useGenerationForm() {
  const context = useContext(GenerationFormContext);
  if (!context) throw new Error('missing GenerationFormProvider in tree');
  return context;
}

export function GenerationFormProvider({ children }: { children: React.ReactNode }) {
  const input = useGenerationStore((state) => state.input);
  const storeData = useGenerationStore((state) => state.data);

  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const { data: responseData, isFetching } = trpc.generation.getGenerationData.useQuery(input!, {
    enabled: input !== undefined,
    keepPreviousData: true,
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

  // #region [effects]
  useEffect(() => {
    if (storeData) {
      const data = formatGenerationData(storeData);
      setValues(data);
    } else if (responseData && !isFetching) {
      if (!input) return;
      const runType = input.type === 'modelVersion' ? 'run' : 'remix';
      const formData = form.getValues();
      const resources =
        runType === 'remix'
          ? responseData.resources
          : [...(formData.resources ?? []), ...responseData.resources];

      const data = formatGenerationData({ ...responseData, resources });

      setValues(runType === 'run' ? removeEmpty(data) : data);
    }
  }, [responseData, status, currentUser, storeData, isFetching, input]); // eslint-disable-line

  useEffect(() => {
    const subscription = form.watch((watchedValues, { name }) => {
      if (
        name !== 'baseModel' &&
        watchedValues.model &&
        getBaseModelSetType(watchedValues.model.baseModel) !== watchedValues.baseModel
      ) {
        form.setValue('baseModel', getBaseModelSetType(watchedValues.model.baseModel));
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);
  // #endregion

  function setValues(data: PartialFormData) {
    // don't overwrite quantity
    const { quantity, ...params } = data;
    const limited = sanitizeTextToImageParams(params, status.limits);
    for (const [key, value] of Object.entries(limited)) {
      form.setValue(key as keyof PartialFormData, value);
    }
  }

  function getDefaultValues(overrides: DeepPartialFormData): PartialFormData {
    return sanitizeTextToImageParams(
      {
        ...defaultValues,
        nsfw: overrides.nsfw ?? false,
        quantity: overrides.quantity ?? defaultValues.quantity,
        tier: currentUser?.tier ?? 'free',
      },
      status.limits
    );
  }

  function reset() {
    form.reset(getDefaultValues(form.getValues()));
  }

  return (
    <GenerationFormContext.Provider value={{ ...form, setValues, reset }}>
      {children}
    </GenerationFormContext.Provider>
  );
}
// #endregion
