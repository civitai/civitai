import {
  Button,
  Grid,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  TooltipProps,
  createStyles,
} from '@mantine/core';
import { TagTarget } from '@prisma/client';
import { IconQuestionMark } from '@tabler/icons';
import { useState } from 'react';
import { z } from 'zod';

import { BackButton } from '~/components/BackButton/BackButton';
import { hiddenLabel, matureLabel } from '~/components/Post/Edit/EditPostControls';
import {
  Form,
  InputImageUpload,
  InputCheckbox,
  InputRTE,
  InputSelect,
  InputTags,
  InputText,
  useForm,
} from '~/libs/form';
import { upsertArticleInput } from '~/server/schema/article.schema';
import { imageSchema } from '~/server/schema/image.schema';
import { ArticleGetById } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const schema = upsertArticleInput.extend({
  categoryId: z.number(),
  cover: z
    .array(imageSchema)
    .transform((val) => {
      if (val && val.length) return val[0].url;
    })
    .nullish(),
});

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

const useStyles = createStyles((theme) => ({
  sidebar: {
    position: 'sticky',
    top: 70 + theme.spacing.xl,
  },
}));

export function ArticleUpsertForm({ article }: Props) {
  const { classes } = useStyles();
  const defaultValues = {
    ...article,
    title: article?.title ?? '',
    content: article?.content,
    categoryId: article?.tags.find((tag) => tag.isCategory)?.id ?? -1,
    tags: article?.tags.filter((tag) => !tag.isCategory) ?? [],
  };
  const form = useForm({ schema, defaultValues });

  const [publishing, setPublishing] = useState(false);

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
    console.log({ rest, tags, publishing });
    // upsertArticleMutation.mutate({ ...rest, tags, publishedAt: publishing ? new Date() : null });
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Grid gutter="xl">
        <Grid.Col span={8}>
          <Stack spacing="xl">
            <Group spacing={4}>
              <BackButton url="/articles" />
              <Title>Create an Article</Title>
            </Group>
            <InputText
              name="title"
              label="Title"
              placeholder="e.g.: How to create your own LoRA"
              withAsterisk
            />
            <InputRTE
              name="content"
              label="Content"
              editorSize="xl"
              includeControls={['heading', 'formatting', 'list', 'link', 'media', 'mentions']}
              withAsterisk
            />
          </Stack>
        </Grid.Col>
        <Grid.Col span={4}>
          <Stack className={classes.sidebar} spacing="xl">
            <Stack spacing={8}>
              <Button
                type="submit"
                variant="default"
                loading={upsertArticleMutation.isLoading}
                onClick={() => setPublishing(false)}
                fullWidth
              >
                Save Draft
              </Button>
              <Button
                type="submit"
                loading={upsertArticleMutation.isLoading}
                onClick={() => setPublishing(true)}
                fullWidth
              >
                Publish
              </Button>
              {article?.publishedAt ? (
                <Text>Published at {formatDate(article.publishedAt)}</Text>
              ) : (
                <Text size="xs" color="dimmed">
                  Your article is currently{' '}
                  <Tooltip label={hiddenLabel} {...tooltipProps}>
                    <Text span underline>
                      hidden
                    </Text>
                  </Tooltip>
                </Text>
              )}
            </Stack>
            <InputCheckbox
              name="nsfw"
              label={
                <Group spacing={4}>
                  Mature
                  <Tooltip label={matureLabel} {...tooltipProps}>
                    <ThemeIcon radius="xl" size="xs" color="gray">
                      <IconQuestionMark />
                    </ThemeIcon>
                  </Tooltip>
                </Group>
              }
            />
            <InputImageUpload
              name="cover"
              label="Cover Image"
              max={1}
              withMeta={false}
              sortable={false}
              withAsterisk
            />
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
          </Stack>
        </Grid.Col>
      </Grid>
    </Form>
  );
}

type Props = { article?: ArticleGetById };
