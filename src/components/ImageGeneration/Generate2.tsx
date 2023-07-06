import { useForm } from 'react-hook-form';
import { GenerateFormModel, generateFormSchema } from '~/server/schema/generation.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import { GenerateForm } from '~/components/ImageGeneration/GenerationForm/GenerateForm';

export function Generate2() {
  const form = useForm<GenerateFormModel>({
    resolver: zodResolver(generateFormSchema),
    mode: 'onSubmit',
    defaultValues,
    shouldUnregister: true,
  });

  return <GenerateForm form={form}></GenerateForm>;
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
