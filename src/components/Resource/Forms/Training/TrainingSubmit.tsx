import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { z } from 'zod';
import { Form, useForm } from '~/libs/form';
import { ModelById } from '~/types/router';

export const TrainingFormSubmit = ({ model }: { model: ModelById }) => {
  const thisStep = 3;

  const schema = z.object({});

  const defaultValues: z.infer<typeof schema> = {
    ...model,
    name: model?.name ?? '',
    // trainingModelType: model?.modelVersions[0]['trainingDetails' as JSONObject]?.type ?? undefined, // TODO [bw] fix
    trainingModelType: model?.modelVersions[0].trainingDetails?.type ?? undefined, // TODO [bw] fix
  };
  console.log(defaultValues);
  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues,
    shouldUnregister: false,
  });

  const { isDirty, errors } = form.formState;

  const handleSubmit = () => {};

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack>
        <Title order={5}>Model Info</Title>
        <Text>Name: {model.name}</Text>
        <Text>Type: {model.modelVersions[0].trainingDetails?.type}</Text>
      </Stack>
      <Stack>
        <Group>
          <Title order={5}>Dataset</Title>
          <Button>Update</Button>
        </Group>
        <Text>Image Count: </Text>
        <Text>Image Samples</Text>
        {/*  images here...*/}
      </Stack>
      <Stack>
        <Title order={5}>Base Model for Training</Title>
        {/*<Input.Wrapper*/}
        {/*  label="Select a base model to train your model on"*/}
        {/*  // error={form.formState.errors.earlyAccessTimeFrame?.message}*/}
        {/*>*/}
        {/*  <InputSegmentedControl*/}
        {/*    name="baseTrainingModel"*/}
        {/*    data={[*/}
        {/*      { label: 'Standard', value: 'standard' },*/}
        {/*      { label: 'Anime', value: 'anime' },*/}
        {/*      { label: 'Realistic', value: 'realistic' },*/}
        {/*    ]}*/}
        {/*    color="blue"*/}
        {/*    size="xs"*/}
        {/*    styles={(theme) => ({*/}
        {/*      root: {*/}
        {/*        border: `1px solid ${*/}
        {/*          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]*/}
        {/*        }`,*/}
        {/*        background: 'none',*/}
        {/*        marginTop: theme.spacing.xs * 0.5, // 5px*/}
        {/*      },*/}
        {/*    })}*/}
        {/*    fullWidth*/}
        {/*  />*/}
        {/*</Input.Wrapper>*/}
      </Stack>
    </Form>
  );
};
