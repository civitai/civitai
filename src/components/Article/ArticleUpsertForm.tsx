import { Button, Grid, Group, Stack, Title } from '@mantine/core';
import { TagTarget } from '@prisma/client';
import { z } from 'zod';

import { BackButton } from '~/components/BackButton/BackButton';
import {
  Form,
  InputImageUpload,
  InputRTE,
  InputSelect,
  InputTags,
  InputText,
  useForm,
} from '~/libs/form';
import { upsertArticleInput } from '~/server/schema/article.schema';
import { ArticleGetById } from '~/types/router';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const schema = upsertArticleInput.extend({
  categoryId: z.number(),
});

export function ArticleUpsertForm({ article }: Props) {
  const defaultValues = {
    ...article,
    title: article?.title ?? '',
    content: article?.content,
    categoryId: article?.tags.find((tag) => tag.isCategory)?.id ?? -1,
    tags: article?.tags.filter((tag) => !tag.isCategory) ?? [],
  };
  const form = useForm({ schema, defaultValues });

  const { data, isLoading: loadingCategories } = trpc.tag.getAll.useQuery({
    categories: true,
    entityType: [TagTarget.Article],
    unlisted: false,
    limit: 100,
  });
  const categories =
    data?.items.map((tag) => ({ label: titleCase(tag.name), value: tag.id })) ?? [];

  const upsertArticleMutation = trpc.article.upsert.useMutation();

  const handleSubmit = ({ categoryId, tags: selectedTags, ...rest }: z.infer<typeof schema>) => {
    const selectedCategory = data?.items.find((cat) => cat.id === categoryId);
    const tags =
      selectedTags && selectedCategory ? selectedTags.concat([selectedCategory]) : selectedTags;
    upsertArticleMutation.mutate({ ...rest, tags });
  };

  return (
    <Stack spacing="xl">
      <Group spacing={4}>
        <BackButton url="/articles" />
        <Title>Create an Article</Title>
      </Group>
      <Form form={form} onSubmit={handleSubmit}>
        <Grid gutter="xl">
          <Grid.Col span={9}>
            <Stack>
              <InputText
                name="title"
                label="Title"
                placeholder="e.g.: How to create your own LoRA"
                withAsterisk
              />
              <InputRTE name="content" label="Content" editorSize="xl" withAsterisk />
            </Stack>
          </Grid.Col>
          <Grid.Col span={3}>
            <Stack spacing="xl">
              <Stack spacing={8}>
                <Button
                  type="submit"
                  variant="default"
                  loading={upsertArticleMutation.isLoading}
                  fullWidth
                >
                  Save Draft
                </Button>
                <Button type="submit" loading={upsertArticleMutation.isLoading} fullWidth>
                  Publish
                </Button>
              </Stack>
              <InputSelect
                name="categoryId"
                label="Category"
                placeholder="Select a category"
                data={categories}
                nothingFound="Nothing found"
                loading={loadingCategories}
                withAsterisk
              />
              <InputTags name="tags" label="Tags" target={[TagTarget.Article]} />
              <InputImageUpload name="cover" label="Cover Image" max={1} withAsterisk />
            </Stack>
          </Grid.Col>
        </Grid>
      </Form>
    </Stack>
  );
}

type Props = { article?: ArticleGetById };
