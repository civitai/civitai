import { useForm } from 'react-hook-form';
import {
  blockedRequest,
  GenerateFormModel,
  generateFormSchema,
} from '~/server/schema/generation.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import { GenerateFormView } from '~/components/ImageGeneration/GenerationForm/GenerateFormView';
import { useEffect } from 'react';
import { useCreateGenerationRequest } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { generationPanel, generationStore, useGenerationStore } from '~/store/generation.store';
import { uniqBy } from 'lodash-es';
import { BaseModel, BaseModelSetType, baseModelSets, generation } from '~/server/common/constants';
import { ModelType } from '@prisma/client';
import { trpc } from '~/utils/trpc';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { calculateGenerationBill } from '~/server/common/generation';
import { isDefined } from '~/utils/type-guards';

type GenerationMaxValueKey = keyof typeof generation.maxValues;
const maxValueKeys = Object.keys(generation.maxValues);
const staticKeys: Array<keyof GenerateFormModel> = ['nsfw', 'quantity'];

export function GenerateFormLogic({ onSuccess }: { onSuccess?: () => void }) {
  const currentUser = useCurrentUser();

  const form = useForm<GenerateFormModel>({
    resolver: zodResolver(generateFormSchema),
    mode: 'onSubmit',
    defaultValues: {
      ...generation.defaultValues,
      // Doing it this way to keep ts happy
      model: { ...generation.defaultValues.model, trainedWords: [] },
      nsfw: currentUser?.showNsfw,
    },
    shouldUnregister: false,
  });

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const runData = useGenerationStore((state) => state.data);
  const opened = useGenerationStore((state) => state.opened);

  useEffect(() => {
    if (runData) {
      const { data, type } = runData;
      const previousData = form.getValues();
      const getFormData = () => {
        // Omitting model to keep ts happy
        const { model, ...defaultValues } = generation.defaultValues;

        switch (type) {
          case 'remix': // 'remix' will return the formatted generation data as is
            return { ...defaultValues, ...data };
          case 'run': // 'run' will keep previous relevant data and add new resources to existing resources
            const baseModel = data.baseModel as BaseModelSetType | undefined;
            const resources = (previousData.resources ?? []).concat(data.resources ?? []);
            const uniqueResources = !!resources.length ? uniqBy(resources, 'id') : undefined;
            const filteredResources = baseModel
              ? uniqueResources?.filter((x) =>
                  baseModelSets[baseModel].includes(x.baseModel as BaseModel)
                )
              : uniqueResources;
            const parsedModel = data.model ?? previousData.model;
            const [model] = parsedModel
              ? baseModel
                ? [parsedModel].filter((x) =>
                    baseModelSets[baseModel].includes(x.baseModel as BaseModel)
                  )
                : [parsedModel]
              : [];

            return {
              ...previousData,
              ...data,
              model,
              resources: filteredResources,
            };
          case 'params':
            return { ...previousData, ...data };
          case 'random': // TODO - handle the case where random includes resources
            return { ...previousData, ...data };
        }
      };

      /*
        !important - form.reset won't work here
        use the schema keys to iterate over each form value
        when setting data, any keys that don't have data will be set to undefined
        this is necessary for 'remix' to work properly.
      */
      const formData = getFormData();
      const keys = Object.keys(generateFormSchema.shape);
      const hasSdxlResources = formData.resources?.some((x) => x.baseModel.includes('SDXL'));
      if (hasSdxlResources) formData.nsfw = false;

      if (!formData.model) {
        // TODO.generation: We need a better way to handle these cases, having hardcoded values
        // is not ideal and may lead to bugs in the future.
        formData.model = hasSdxlResources
          ? {
              id: 128078,
              name: 'v1.0 VAE fix',
              trainedWords: [],
              modelId: 101055,
              modelName: 'SD XL',
              modelType: 'Checkpoint',
              baseModel: 'SDXL 1.0',
              strength: 1,
            }
          : {
              id: 128713,
              name: '8',
              trainedWords: [],
              modelId: 4384,
              modelName: 'DreamShaper',
              modelType: 'Checkpoint',
              baseModel: 'SD 1.5',
              strength: 1,
            };
      }

      for (const item of keys) {
        const key = item as keyof typeof formData;
        if (staticKeys.includes(key)) continue; // don't overwrite nsfw

        // Make sure we don't exceed max values
        if (maxValueKeys.includes(key))
          form.setValue(
            key,
            Math.min(
              formData[key as GenerationMaxValueKey] ?? 0,
              generation.maxValues[key as GenerationMaxValueKey] ?? 0
            )
          );
        else form.setValue(key, formData[key]);
      }
    }

    return () => {
      if (!opened) generationStore.clearData();
    };
  }, [runData, opened]); //eslint-disable-line

  const { mutateAsync, isLoading } = useCreateGenerationRequest();
  const handleSubmit = async (data: GenerateFormModel) => {
    if (isLoading) {
      return;
    }

    const { model, resources = [], vae, ...params } = data;
    const _resources = [...[model].filter(isDefined), ...resources].map((resource) => {
      if (resource.modelType === ModelType.TextualInversion)
        return { ...resource, triggerWord: resource.trainedWords[0] };
      return resource;
    });
    if (vae) _resources.push(vae);

    const totalCost = calculateGenerationBill(data);
    const performTransaction = async () => {
      await mutateAsync({
        resources: _resources.filter((x) => x.covered !== false),
        params,
      });

      onSuccess?.();
      generationPanel.setView('queue'); // TODO.generation - determine what should actually happen after clicking 'generate'
    };

    conditionalPerformTransaction(totalCost, performTransaction);
  };

  const { mutateAsync: reportProhibitedRequest } = trpc.user.reportProhibitedRequest.useMutation();
  const handleError = async (e: unknown) => {
    const promptError = (e as any)?.prompt as any;
    if (promptError?.type === 'custom') {
      const status = blockedRequest.status();
      if (status === 'notified' || status === 'muted') {
        const isBlocked = await reportProhibitedRequest({ prompt: promptError.ref.value });
        if (isBlocked) currentUser?.refresh();
      }
    }
  };

  return (
    <GenerateFormView
      form={form}
      onSubmit={handleSubmit}
      onError={handleError}
      loading={isLoading}
    />
  );
}
