import { useForm } from 'react-hook-form';
import { GenerateFormModel, generateFormSchema } from '~/server/schema/generation.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import { GenerateForm } from '~/components/ImageGeneration/GenerationForm/GenerateForm';
import { Card, Stack, Button, Group } from '@mantine/core';

export function Generate2() {
  const form = useForm<GenerateFormModel>({
    resolver: zodResolver(generateFormSchema.partial()),
    mode: 'onSubmit',
    defaultValues,
    shouldUnregister: true,
  });

  return (
    <Stack>
      <GenerateForm form={form}></GenerateForm>
      <Card title="Testing">
        <Stack>
          <Group>
            <Button onClick={() => form.setValue('steps', form.getValues('steps') - 1)}>
              Steps -
            </Button>
            <Button onClick={() => form.setValue('steps', form.getValues('steps') + 1)}>
              Steps +
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
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
