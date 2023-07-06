import { useForm } from 'react-hook-form';
import { GenerateFormModel, generateFormSchema } from '~/server/schema/generation.schema';
import { zodResolver } from '@hookform/resolvers/zod';
import { GenerateForm } from '~/components/ImageGeneration/GenerationForm/GenerateForm';
import { Card, Stack, Button, Group } from '@mantine/core';
import { useEffect } from 'react';

export function Generate2() {
  const form = useForm<GenerateFormModel>({
    resolver: zodResolver(generateFormSchema.partial()),
    mode: 'onSubmit',
    defaultValues,
    shouldUnregister: true,
  });

  useEffect(() => {
    const subscription = form.watch((value, { name, type }) => {
      // do things with the form here (remove values, add values)
      console.log({ value, name, type });

      // reset emits an empty value object (value = {})
    });
    return () => subscription.unsubscribe();
  }, []); //eslint-disable-line

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
          <Button onClick={() => form.reset({ prompt: 'this is a test', clipSkip: 3 })}>
            Reset With Prompt
          </Button>
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
