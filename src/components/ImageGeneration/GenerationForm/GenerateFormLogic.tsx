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

export function GenerateFormLogic({ onSuccess }: { onSuccess?: () => void }) {
  const currentUser = useCurrentUser();

  const form = useForm<GenerateFormModel>({
    resolver: zodResolver(generateFormSchema),
    mode: 'onSubmit',
    defaultValues: {
      ...generation.defaultValues,
      nsfw: currentUser?.showNsfw,
    },
    shouldUnregister: false,
  });

  const runData = useGenerationStore((state) => state.data);

  useEffect(() => {
    if (runData) {
      const { data, type } = runData;
      const previousData = form.getValues();
      const getFormData = () => {
        switch (type) {
          case 'remix': // 'remix' will return the formatted generation data as is
            return { ...generation.defaultValues, ...data };
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
      const staticKeys: Array<keyof GenerateFormModel> = ['nsfw', 'quantity'];
      const formData = getFormData();
      const keys = Object.keys(generateFormSchema.shape);
      for (const item of keys) {
        const key = item as keyof typeof formData;
        if (staticKeys.includes(key)) continue; // don't overwrite nsfw
        form.setValue(key, formData[key]);
      }
    }

    return () => {
      generationStore.clearData();
    };
  }, [runData]); //eslint-disable-line

  const { mutateAsync } = useCreateGenerationRequest();
  const handleSubmit = async (data: GenerateFormModel) => {
    const { model, resources = [], vae, ...params } = data;
    const _resources = [model, ...resources].map((resource) => {
      if (resource.modelType === ModelType.TextualInversion)
        return { ...resource, triggerWord: resource.trainedWords[0] };
      return resource;
    });
    if (vae) _resources.push(vae);

    await mutateAsync({
      resources: _resources.filter((x) => x.covered !== false),
      params,
    });

    onSuccess?.();
    generationPanel.setView('queue'); // TODO.generation - determine what should actually happen after clicking 'generate'
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

  return <GenerateFormView form={form} onSubmit={handleSubmit} onError={handleError} />;
}
