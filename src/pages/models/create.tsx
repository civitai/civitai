import { Button, Container, MultiSelect, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { FormErrors, useForm, zodResolver } from '@mantine/form';
import { GetServerSideProps } from 'next';
import { useState } from 'react';
import { z } from 'zod';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { modelSchema } from '~/server/common/validation/model';

type CreateModelProps = Partial<z.infer<typeof modelSchema>>;
type MultiSelectCreatable = Array<{ value: string; label: string }>;

export default function Create() {
  const form = useForm<CreateModelProps>({
    validate: zodResolver(modelSchema.passthrough()),
    initialValues: {
      name: '',
      description: '',
      trainedWords: [],
      type: 'Checkpoint',
      tags: [],
      nsfw: false,
      modelVersions: [],
    },
  });

  const [trainedWords, setTrainedWords] = useState<MultiSelectCreatable>([]);

  const handleSubmit = (data: CreateModelProps) => {
    console.log({ data });
  };

  const handleError = (error: FormErrors) => {
    console.error(error);
  };

  return (
    <Container>
      <form onSubmit={form.onSubmit(handleSubmit, handleError)} noValidate>
        <Stack>
          <TextInput {...form.getInputProps('name')} label="Name" placeholder="Name" required />
          <Textarea
            {...form.getInputProps('description')}
            label="About your model"
            maxLength={240}
          />
          <Select
            {...form.getInputProps('type')}
            label="Type"
            placeholder="Type"
            data={['Checkpoint', 'TextualInversion', 'Hypernetwork']}
            required
          />
          <MultiSelect
            {...form.getInputProps('trainedWords')}
            label="Trained Words"
            placeholder="e.g.: Master Chief"
            description="Please input the words you have trained your model with"
            data={trainedWords}
            getCreateLabel={(query) => `+ Create ${query}`}
            onCreate={(query) => {
              const item = { value: query, label: query };
              setTrainedWords((current) => [...current, item]);
              return item;
            }}
            clearButtonLabel="Clear trained words"
            creatable
            clearable
            searchable
            required
          />
          <Button type="submit">Submit</Button>
        </Stack>
      </form>
    </Container>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerAuthSession(ctx);

  if (!session) {
    return {
      redirect: {
        destination: '/login',
        permanent: false,
      },
    };
  }

  return { props: {} };
};
