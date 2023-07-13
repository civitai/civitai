import { useForm } from 'react-hook-form';
import { GenerateFormModel, generateFormSchema } from '~/server/schema/generation.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import { GenerateFormView } from '~/components/ImageGeneration/GenerationForm/GenerateFormView';
import { useEffect } from 'react';
import { useCreateGenerationRequest } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { generationPanel, generationStore, useGenerationStore } from '~/store/generation.store';
import { uniqBy } from 'lodash-es';

export function GenerateFormLogic({ onSuccess }: { onSuccess?: () => void }) {
  const currentUser = useCurrentUser();

  const form = useForm<GenerateFormModel>({
    resolver: zodResolver(generateFormSchema),
    mode: 'onSubmit',
    defaultValues: {
      ...defaultValues,
      nsfw: currentUser?.showNsfw,
    },
    shouldUnregister: true,
  });

  const runData = useGenerationStore((state) => state.data);

  useEffect(() => {
    if (!runData) return;
    const { data, type } = runData;

    const getFormData = () => {
      const previousData = form.getValues();
      switch (type) {
        case 'remix': // 'remix' will return the formatted generation data as is
          return data;
        case 'run': // 'run' will keep previous relevant data and add new resources to existing resources
          const resources = (previousData.resources ?? []).concat(data.resources ?? []);
          return { ...previousData, ...data, resources: uniqBy(resources, 'id') };
        case 'random':
          return { ...previousData, ...data };
      }
    };

    /*
      !important
      use the schema keys to iterate over each form value
      when setting data, any keys that don't have data will be set to undefined
      this is necessary for 'remix' to work properly.
    */
    const formData = getFormData();
    const keys = Object.keys(generateFormSchema.shape);
    for (const item of keys) {
      const key = item as keyof typeof formData;
      form.setValue(key, formData[key]);
    }

    return () => {
      generationStore.clearData();
    };
  }, [runData]); //eslint-disable-line

  const { mutateAsync } = useCreateGenerationRequest();
  const handleSubmit = async (data: GenerateFormModel) => {
    const { model, resources = [], vae, aspectRatio, ...params } = data;
    const [width, height] = aspectRatio.split('x').map(Number);
    const _resources = [model, ...resources];
    if (vae) _resources.push(vae);

    await mutateAsync({
      resources: _resources.filter((x) => x.covered !== false),
      params: {
        ...params,
        width,
        height,
      },
    });

    onSuccess?.();
    generationPanel.setView('queue'); // TODO.generation - determine what should actually happen after clicking 'generate'
  };

  return <GenerateFormView form={form} onSubmit={handleSubmit} />;
}

const defaultValues = {
  cfgScale: 7,
  steps: 25,
  sampler: 'DPM++ 2M Karras',
  seed: undefined,
  clipSkip: 2,
  quantity: 4,
  aspectRatio: '512x512',
  prompt: '',
  negativePrompt: '',
};
