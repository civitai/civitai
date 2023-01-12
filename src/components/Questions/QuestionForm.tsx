import { Grid, Group, Stack, Paper, Button, Container, ActionIcon, Title } from '@mantine/core';
import { useForm, Form, InputText, InputMultiSelect, InputRTE } from '~/libs/form';
import { QuestionDetailProps } from '~/server/controllers/question.controller';
import { upsertQuestionSchema } from '~/server/schema/question.schema';
import { trpc } from '~/utils/trpc';
import { z } from 'zod';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import { showNotification } from '@mantine/notifications';
import { IconArrowLeft, IconCheck, IconX } from '@tabler/icons';
import { slugit } from '~/utils/string-helpers';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { TagTarget } from '@prisma/client';

const schema = upsertQuestionSchema.extend({ tags: z.string().array().nullish() });

export function QuestionForm({ question }: { question?: QuestionDetailProps }) {
  const router = useRouter();
  const queryUtils = trpc.useContext();

  const form = useForm({
    schema: schema,
    defaultValues: { ...question, tags: question?.tags?.map((x) => x.name) },
  });

  const { data: { items: tags } = { items: [] } } = trpc.tag.getAll.useQuery(
    { limit: 0, entityType: TagTarget.Question },
    { cacheTime: Infinity, staleTime: Infinity }
  );
  const questionTags = form.watch('tags');
  const tagsData = useMemo(
    () => Array.from(new Set([...(questionTags ?? []), ...tags.map((x) => x.name)])),
    [questionTags, tags]
  );

  const { mutate, isLoading } = trpc.question.upsert.useMutation({
    async onSuccess(results, input) {
      const questionLink = `/questions/${results.id}/${slugit(results.title ?? '')}`;

      showNotification({
        title: 'Your model was saved',
        message: `Successfully ${!!input.id ? 'updated' : 'created'} the model.`,
        color: 'teal',
        icon: <IconCheck size={18} />,
      });

      await queryUtils.question.invalidate();
      await queryUtils.tag.invalidate();

      router.push(questionLink, undefined, {
        shallow: !!input.id,
      });
    },
    onError(error: TRPCClientErrorBase<DefaultErrorShape>) {
      const message = error.message;

      showNotification({
        title: 'Could not save question',
        message: `An error occurred while saving the question: ${message}`,
        color: 'red',
        icon: <IconX size={18} />,
      });
    },
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    const data = {
      ...question,
      ...values,
      tags: values.tags?.map((name) => {
        const match = tags.find((x) => x.name === name);
        return match ?? { name };
      }),
    };
    mutate(data);
  };

  return (
    <Container>
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title order={3}>{question ? 'Editing question' : 'Ask a question'}</Title>
      </Group>
      <Form form={form} onSubmit={handleSubmit}>
        <Grid gutter="xl">
          <Grid.Col lg={8}>
            <Paper radius="md" p="xl" withBorder>
              <Stack>
                <InputText name="title" label="Title" withAsterisk />
                <InputRTE
                  name="content"
                  label="Content"
                  withAsterisk
                  includeControls={['heading', 'formatting', 'list', 'link', 'media']}
                />
              </Stack>
            </Paper>
          </Grid.Col>
          <Grid.Col lg={4}>
            <Paper radius="md" p="xl" withBorder>
              <Stack>
                <InputMultiSelect
                  data={tagsData}
                  name="tags"
                  label="Tags"
                  placeholder="e.g.: portrait, sharp focus, etc."
                  description="Please add your tags"
                  creatable
                  getCreateLabel={(query) => `+ Create ${query}`}
                  clearable
                  searchable
                />
                <Group position="right" noWrap>
                  <Button
                    variant="outline"
                    onClick={() => form.reset()}
                    disabled={!form.formState.isDirty || isLoading}
                  >
                    Discard Changes
                  </Button>
                  <Button type="submit" loading={isLoading}>
                    Save
                  </Button>
                </Group>
              </Stack>
            </Paper>
          </Grid.Col>
        </Grid>
      </Form>
    </Container>
  );
}
