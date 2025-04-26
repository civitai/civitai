import {
  Anchor,
  Button,
  ButtonProps,
  Group,
  Stack,
  StackProps,
  Text,
  Title,
  Tooltip,
  TooltipProps,
  ActionIcon,
  Paper,
  Input,
} from '@mantine/core';
import { ArticleStatus, TagTarget } from '~/shared/utils/prisma/enums';
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
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import classes from './ArticleUpsertForm.module.scss';

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

export const browsingLevelSelectOptions = browsingLevels.map((level) => ({
  label: browsingLevelLabels[level],
  value: String(level),
}));

export function ArticleUpsertForm({ article }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const features = useFeatureFlags();
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
        status: publishing ? ArticleStatus.Published : undefined,
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
      <ReadOnlyAlert
        message={
          "Civitai is currently in read-only mode and you won't be able to publish or see changes made to this article."
        }
      />
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
                disabled: upsertArticleMutation.isLoading || !features.canWrite,
                onClick: () => setPublishing(false),
              }}
              publishButtonProps={{
                loading: upsertArticleMutation.isLoading && publishing,
                disabled: upsertArticleMutation.isLoading || !features.canWrite,
                onClick: () => setPublishing(true),
              }}
              className={classes.hideMobile}
            />
            <InputSelect
              name="userNsfwLevel"
              label="Content Level"
              placeholder="Select content level"
              data={browsingLevelSelectOptions}
              disabled={!canEditUserNsfwLevel}
              rightSection={
                <Tooltip
                  {...tooltipProps}
                  label="Content level determines who can see this article"
                >
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    onClick={(e) => {
                      e.preventDefault();
                      openBrowsingLevelGuide();
                    }}
                  >
                    <IconQuestionMark size={16} />
                  </ActionIcon>
                </Tooltip>
              }
            />
            <InputSelect
              name="categoryId"
              label="Category"
              placeholder="Select a category"
              data={categories}
              loading={loadingCategories}
              withAsterisk
            />
            <InputTags
              name="tags"
              label="Tags"
              placeholder="Add tags"
              maxSelectedValues={10}
              clearable
            />
            <InputSimpleImageUpload
              name="coverImage"
              label="Cover Image"
              aspectRatio={16 / 9}
              withAsterisk
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
        <Button
          {...(article.status !== ArticleStatus.Published ? publishButtonProps : saveButtonProps)}
          type="submit"
          fullWidth
        >
          {article.status !== ArticleStatus.Published ? 'Publish' : 'Save'}
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

