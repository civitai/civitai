import {
  Anchor,
  Button,
  ButtonProps,
  Group,
  Stack,
  StackProps,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  TooltipProps,
  createStyles,
  ActionIcon,
  Paper,
  Input,
} from '@mantine/core';
import { TagTarget } from '@prisma/client';
import { IconQuestionMark, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { BackButton } from '~/components/BackButton/BackButton';
import { useFormStorage } from '~/hooks/useFormStorage';
import {
  Form,
  InputMultiFileUpload,
  InputRTE,
  InputSelect,
  InputSimpleImageUpload,
  InputTags,
  InputText,
  useForm,
} from '~/libs/form';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { upsertArticleInput } from '~/server/schema/article.schema';
import type { ArticleGetById } from '~/server/services/article.service';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { parseNumericString } from '~/utils/query-string-helpers';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { FeatureIntroductionHelpButton } from '../FeatureIntroduction/FeatureIntroduction';
import { ContentPolicyLink } from '../ContentPolicyLink/ContentPolicyLink';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { constants } from '~/server/common/constants';
import { imageSchema } from '~/server/schema/image.schema';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { openBrowsingLevelGuide } from '~/components/Dialog/dialog-registry';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const schema = upsertArticleInput.omit({ coverImage: true, userNsfwLevel: true }).extend({
  categoryId: z.number().min(0, 'Please select a valid category'),
  coverImage: imageSchema.refine((data) => !!data.url, { message: 'Please upload a cover image' }),
  userNsfwLevel: z.string().optional(),
});
const querySchema = z.object({
  category: z.preprocess(parseNumericString, z.number().optional().default(-1)),
});

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
  zIndex: 10,
  withinPortal: true,
};

const useStyles = createStyles((theme) => ({
  sidebar: {
    position: 'sticky',
    top: 70 + theme.spacing.xl,
  },
}));

export const browsingLevelSelectOptions = browsingLevels.map((level) => ({
  label: browsingLevelLabels[level],
  value: String(level),
}));

export function ArticleUpsertForm({ article }: Props) {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const result = querySchema.safeParse(router.query);

  const defaultCategory = result.success ? result.data.category : -1;

  const lockedPropertiesRef = useRef<string[]>(article?.lockedProperties ?? []);
  const canEditUserNsfwLevel = !currentUser?.isModerator
    ? !article?.lockedProperties?.includes('userNsfwLevel')
    : true;

  const form = useForm({
    schema,
    shouldUnregister: false,
    defaultValues: {
      ...article,
      title: article?.title ?? '',
      content: article?.content ?? '',
      userNsfwLevel: article?.userNsfwLevel ? String(article.userNsfwLevel) : undefined,
      categoryId: article?.tags.find((tag) => tag.isCategory)?.id ?? defaultCategory,
      tags: article?.tags.filter((tag) => !tag.isCategory) ?? [],
      coverImage: article?.coverImage ?? null,
    } as any,
  });
  const clearStorage = useFormStorage({
    schema,
    form,
    timeout: 1000,
    key: `article${article?.id ? `_${article?.id}` : 'new'}`,
    watch: ({ content, coverImage, categoryId, tags, title }) => ({
      content,
      coverImage,
      categoryId,
      tags,
      title,
    }),
  });
  const [userNsfwLevel] = form.watch(['userNsfwLevel']);
  useEffect(() => {
    if (currentUser?.isModerator) {
      if (userNsfwLevel)
        lockedPropertiesRef.current = [
          ...new Set([...lockedPropertiesRef.current, 'userNsfwLevel']),
        ];
      else
        lockedPropertiesRef.current = lockedPropertiesRef.current.filter(
          (x) => x !== 'userNsfwLevel'
        );
    }
  }, [currentUser?.isModerator, userNsfwLevel]);

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

  const handleSubmit = ({
    categoryId,
    tags: selectedTags,
    coverImage,
    userNsfwLevel,
    ...rest
  }: z.infer<typeof schema>) => {
    const selectedCategory = data?.items.find((cat) => cat.id === categoryId);
    const tags =
      selectedTags && selectedCategory ? selectedTags.concat([selectedCategory]) : selectedTags;
    upsertArticleMutation.mutate(
      {
        ...rest,
        userNsfwLevel: canEditUserNsfwLevel
          ? userNsfwLevel
            ? Number(userNsfwLevel)
            : 0
          : undefined,
        tags,
        publishedAt: publishing ? new Date() : null,
        coverImage: coverImage,
        lockedProperties: lockedPropertiesRef.current,
      },
      {
        async onSuccess(result) {
          await router.push(`/articles/${result.id}`);
          await queryUtils.article.getById.invalidate({ id: result.id });
          await queryUtils.article.getInfinite.invalidate();
          clearStorage();
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to save article',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <ContainerGrid gutter="xl">
        <ContainerGrid.Col xs={12} md={8}>
          <Stack spacing="xl">
            <Group spacing={8} noWrap>
              <BackButton url="/articles" />
              <Title>{article?.id ? 'Editing article' : 'Create an Article'}</Title>
              <FeatureIntroductionHelpButton
                feature="article-create"
                contentSlug={['feature-introduction', 'article-create']}
              />
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
              includeControls={[
                'heading',
                'formatting',
                'list',
                'link',
                'media',
                'polls',
                'colors',
              ]}
              withAsterisk
              stickyToolbar
            />
          </Stack>
        </ContainerGrid.Col>
        <ContainerGrid.Col xs={12} md={4}>
          <Stack className={classes.sidebar} spacing="xl">
            <ActionButtons
              article={article}
              saveButtonProps={{
                loading: upsertArticleMutation.isLoading && !publishing,
                disabled: upsertArticleMutation.isLoading,
                onClick: () => setPublishing(false),
              }}
              publishButtonProps={{
                loading: upsertArticleMutation.isLoading && publishing,
                disabled: upsertArticleMutation.isLoading,
                onClick: () => setPublishing(true),
              }}
              sx={hideMobile}
            />
            <InputSelect
              name="userNsfwLevel"
              data={browsingLevelSelectOptions}
              label={
                <Group spacing={4} noWrap>
                  Maturity Level
                  <ActionIcon
                    radius="xl"
                    size="xs"
                    variant="outline"
                    onClick={openBrowsingLevelGuide}
                  >
                    <IconQuestionMark />
                  </ActionIcon>
                  <ContentPolicyLink size="xs" variant="text" color="dimmed" td="underline" />
                </Group>
              }
            />
            <InputSimpleImageUpload
              name="coverImage"
              label="Cover Image"
              description={`Suggested resolution: ${constants.profile.coverImageWidth} x ${constants.profile.coverImageHeight}`}
              withAsterisk
            />
            <InputSelect
              name="categoryId"
              label={
                <Group spacing={4} noWrap>
                  <Input.Label required>Category</Input.Label>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 14 }}>
                    <Text>
                      Categories determine what kind of article you&apos;re making. Selecting a
                      category that&apos;s the closest match to your subject helps users find your
                      article
                    </Text>
                  </InfoPopover>
                </Group>
              }
              placeholder="Select a category"
              data={categories}
              nothingFound="Nothing found"
              loading={loadingCategories}
            />
            <InputTags
              name="tags"
              label={
                <Group spacing={4} noWrap>
                  <Input.Label>Tags</Input.Label>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 14 }}>
                    <Text>
                      Tags are how users filter content on the site. It&apos;s important to
                      correctly tag your content so it can be found by interested users
                    </Text>
                  </InfoPopover>
                </Group>
              }
              target={[TagTarget.Article]}
              filter={(tag) =>
                data && tag.name ? !data.items.map((cat) => cat.name).includes(tag.name) : true
              }
            />
            <InputMultiFileUpload
              name="attachments"
              label={
                <Group spacing={4} noWrap>
                  <Input.Label>Attachments</Input.Label>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 14 }}>
                    <Text>
                      Attachments may be additional context for your article, training data, or
                      larger files that don&apos;t make sense to post as a model
                    </Text>
                  </InfoPopover>
                </Group>
              }
              dropzoneProps={{
                maxSize: 30 * 1024 ** 2, // 30MB
                maxFiles: 10,
                accept: {
                  'application/pdf': ['.pdf'],
                  'application/zip': ['.zip'],
                  'application/json': ['.json'],
                  'application/x-yaml': ['.yaml', '.yml'],
                  'text/plain': ['.txt'],
                  'text/markdown': ['.md'],
                  'text/x-python-script': ['.py'],
                },
              }}
              renderItem={(file, onRemove) => (
                <Paper key={file.id} radius="sm" p={0} w="100%">
                  <Group position="apart">
                    {article && file.id ? (
                      <Anchor href={`/api/download/attachments/${file.id}`} lineClamp={1} download>
                        {file.name}
                      </Anchor>
                    ) : (
                      <Text size="sm" weight={500} lineClamp={1}>
                        {file.name}
                      </Text>
                    )}
                    <Tooltip label="Remove">
                      <ActionIcon size="sm" color="red" variant="transparent" onClick={onRemove}>
                        <IconTrash />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Paper>
              )}
            />
            <ActionButtons
              article={article}
              saveButtonProps={{
                loading: upsertArticleMutation.isLoading && !publishing,
                disabled: upsertArticleMutation.isLoading,
                onClick: () => setPublishing(false),
              }}
              publishButtonProps={{
                loading: upsertArticleMutation.isLoading && publishing,
                disabled: upsertArticleMutation.isLoading,
                onClick: () => setPublishing(true),
              }}
              sx={showMobile}
            />
          </Stack>
        </ContainerGrid.Col>
      </ContainerGrid>
    </Form>
  );
}

type Props = { article?: ArticleGetById };

function ActionButtons({
  article,
  className,
  saveButtonProps,
  publishButtonProps,
  ...stackProps
}: ActionButtonProps) {
  return (
    <Stack spacing={8} {...stackProps}>
      {article?.publishedAt ? (
        <Button {...publishButtonProps} type="submit" fullWidth>
          Save
        </Button>
      ) : (
        <>
          <Button {...saveButtonProps} type="submit" variant="default" fullWidth>
            Save Draft
          </Button>
          <Button {...publishButtonProps} type="submit" fullWidth>
            Publish
          </Button>
        </>
      )}
      {article?.publishedAt ? (
        <Text size="xs" color="dimmed">
          Published at {formatDate(article.publishedAt)}
        </Text>
      ) : (
        <Text size="xs" color="dimmed">
          Your article is currently{' '}
          <Tooltip
            label="Click the publish button to make your article public to share with the Civitai community for comments and reactions."
            {...tooltipProps}
          >
            <Text span underline>
              hidden
            </Text>
          </Tooltip>
        </Text>
      )}
    </Stack>
  );
}

type FormButtonProps = Pick<ButtonProps, 'disabled' | 'loading'> & {
  onClick: React.MouseEventHandler<HTMLButtonElement>;
};

type ActionButtonProps = StackProps & {
  saveButtonProps: FormButtonProps;
  publishButtonProps: FormButtonProps;
  article?: ArticleGetById;
};
