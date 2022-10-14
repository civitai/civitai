import {
  ActionIcon,
  Button,
  Checkbox,
  Container,
  Grid,
  Group,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { IconArrowLeft } from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { z } from 'zod';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { modelSchema } from '~/server/common/validation/model';

type CreateModelProps = Partial<z.infer<typeof modelSchema>>;
type MultiSelectCreatable = Array<{ value: string; label: string }>;

export default function Create() {
  const router = useRouter();
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
  const [tags, setTags] = useState<MultiSelectCreatable>([]);

  const handleSubmit = (data: CreateModelProps) => {
    console.log({ data });
  };

  return (
    <Container>
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title>Upload model</Title>
      </Group>
      <form onSubmit={form.onSubmit(handleSubmit, console.error)} noValidate>
        <Grid gutter="xl">
          <Grid.Col lg={8}>
            <Paper radius="md" p="xl" withBorder>
              <Stack>
                <TextInput
                  label="Name"
                  placeholder="Name"
                  withAsterisk
                  {...form.getInputProps('name')}
                />
                <Textarea
                  label="About your model"
                  placeholder="Tell us what your model does"
                  maxLength={240}
                  {...form.getInputProps('description')}
                />
              </Stack>
            </Paper>
          </Grid.Col>
          <Grid.Col lg={4}>
            <Paper radius="md" p="xl" withBorder>
              <Stack>
                <Select
                  label="Type"
                  placeholder="Type"
                  data={['Checkpoint', 'TextualInversion', 'Hypernetwork']}
                  withAsterisk
                  {...form.getInputProps('type')}
                />
                <MultiSelect
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
                  withAsterisk
                  {...form.getInputProps('trainedWords')}
                />
                <MultiSelect
                  label="Tags"
                  placeholder="e.g.: portrait, sharp focus, etc."
                  description="Please add your tags"
                  data={tags}
                  getCreateLabel={(query) => `+ Create ${query}`}
                  onCreate={(query) => {
                    const item = { value: query, label: query };
                    setTags((current) => [...current, item]);

                    return item;
                  }}
                  clearButtonLabel="Clear tags"
                  creatable
                  clearable
                  searchable
                  {...form.getInputProps('tags')}
                />
                <Checkbox
                  label="This model or images associated with it are NSFW"
                  {...form.getInputProps('nsfw', { type: 'checkbox' })}
                />
              </Stack>
            </Paper>
          </Grid.Col>
        </Grid>

        <Group align="flex-end">
          <Button type="submit">Submit</Button>
        </Group>
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
