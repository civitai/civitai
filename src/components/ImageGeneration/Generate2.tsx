import { useForm } from 'react-hook-form';
import { GenerateFormModel, generateFormSchema } from '~/server/schema/generation.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import { GenerateForm } from '~/components/ImageGeneration/GenerationForm/GenerateForm';
import { Card, Stack, Button, Group } from '@mantine/core';
import { useEffect } from 'react';
import { useCreateGenerationRequest } from '~/components/ImageGeneration/utils/generationRequestHooks';
import useFormPersist from '~/libs/form/hooks/useFormPersist';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { generationPanel, generationStore, useGenerationStore } from '~/store/generation.store';
import { uniqBy } from 'lodash-es';
import { openConfirmModal } from '@mantine/modals';

export function Generate2() {
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

  useFormPersist('generate-form-test', {
    form,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  });

  // const previous = usePrevious(data)
  useEffect(() => {
    if (!runData) return;
    const { data, type } = runData;

    const getFormData = () => {
      // remix will return the formatted generation data as is
      if (type === 'remix') return data;
      // run will return
      const previousData = form.getValues();
      const resources = previousData.resources ?? [];
      return { ...data, resources: uniqBy(resources.concat(data.resources ?? []), 'id') };
    };

    const formData = getFormData();

    for (const item in formData) {
      const key = item as keyof typeof formData;
      form.setValue(key, formData[key]);
    }
    // TODO.generation - determine if we need a confirm modal for setting recommended clipSkip/vae
    // if (type === 'run' && (data.clipSkip !== undefined || data.vae !== undefined)) {
    // }
    return () => {
      generationStore.clearData();
    };
  }, [runData]); //eslint-disable-line

  const { mutateAsync, isLoading } = useCreateGenerationRequest();

  const handleSubmit = async (data: GenerateFormModel) => {
    const { model, resources = [], aspectRatio, ...params } = data;
    const [width, height] = aspectRatio.split('x').map(Number);
    await mutateAsync({
      resources: [model, ...resources], // TODO - vae support
      params: {
        ...params,
        width,
        height,
      },
    });
    generationPanel.setView('queue');
  };

  return <GenerateForm form={form} onSubmit={handleSubmit} isLoading={isLoading} />;
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
