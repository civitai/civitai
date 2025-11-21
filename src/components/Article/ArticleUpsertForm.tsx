import type { ButtonProps, StackProps, TooltipProps } from '@mantine/core';
import { Anchor, Button, Group, Input, Paper, Stack, Text, Title, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconQuestionMark, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as z from 'zod';

import { ArticleScanStatus } from '~/components/Article/ArticleScanStatus';
import { BackButton } from '~/components/BackButton/BackButton';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { ContentPolicyLink } from '~/components/ContentPolicyLink/ContentPolicyLink';
import { openBrowsingLevelGuide } from '~/components/Dialog/triggers/browsing-level-guide';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';
import { UploadNotice } from '~/components/UploadNotice/UploadNotice';
import { useArticleScanStatus } from '~/hooks/useArticleScanStatus';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { upsertArticleInput } from '~/server/schema/article.schema';
import { imageSchema } from '~/server/schema/image.schema';
import type { ArticleGetById } from '~/server/services/article.service';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { ArticleStatus, TagTarget } from '~/shared/utils/prisma/enums';
import { extractImagesFromArticle } from '~/utils/article-helpers';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { parseNumericString } from '~/utils/query-string-helpers';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const schema = upsertArticleInput.omit({ coverImage: true, userNsfwLevel: true }).extend({
  categoryId: z.number().min(0, 'Please select a valid category'),
  coverImage: imageSchema.refine((data) => !!data.url, { error: 'Please upload a cover image' }),
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
  const [userNsfwLevel, content] = form.watch(['userNsfwLevel', 'content']);
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
    content,
    ...rest
  }: z.infer<typeof schema>) => {
    const selectedCategory = data?.items.find((cat) => cat.id === categoryId);
    const tags =
      selectedTags && selectedCategory ? selectedTags.concat([selectedCategory]) : selectedTags;

    const submitArticle = (args?: { status?: ArticleStatus }) => {
      upsertArticleMutation.mutate(
        {
          ...rest,
          content,
          userNsfwLevel: canEditUserNsfwLevel
            ? userNsfwLevel
              ? Number(userNsfwLevel)
              : 0
            : undefined,
          tags,
          // publishedAt will be set server-side based on status
          status: args?.status ? args.status : publishing ? ArticleStatus.Published : undefined,
          coverImage,
          lockedProperties: lockedPropertiesRef.current,
        },
        {
          async onSuccess(result) {
            clearStorage();

            await Promise.all([
              queryUtils.article.getById.invalidate({ id: result.id }),
              queryUtils.article.getScanStatus.invalidate({ id: result.id }),
              queryUtils.article.getInfinite.invalidate(),
            ]);
            await router.push(`/articles/${result.id}`);
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

    // Check if publishing or updating published article with embedded images
    const contentImages = features.articleImageScanning ? extractImagesFromArticle(content) : [];

    if (contentImages.length > 0 && (publishing || article?.status === ArticleStatus.Published)) {
      // Check if images are already in the database
      const existingImageUrls = new Set(article?.contentImages?.map((img) => img.url) || []);
      const newImages = contentImages.filter((img) => !existingImageUrls.has(img.url));

      if (newImages.length === 0) {
        // All images already exist in database, no scanning delay expected
        submitArticle();
        return;
      }

      // Has new images that need scanning, show confirmation modal
      openConfirmModal({
        title: 'Article Image Processing',
        children: (
          <Stack gap="sm">
            <Text>
              Your article contains {newImages.length} new embedded image
              {newImages.length > 1 ? 's' : ''} that need to be scanned for content safety.
            </Text>
            {existingImageUrls.size > 0 && (
              <Text size="sm" c="dimmed">
                ({existingImageUrls.size} existing image{existingImageUrls.size > 1 ? 's' : ''}{' '}
                already processed)
              </Text>
            )}
            <Text>
              This article will be set to <strong>Processing</strong> status while images are being
              scanned. This could take some time, and your article will automatically publish when
              complete.
            </Text>
            <Text size="sm" c="dimmed">
              You&apos;ll receive a notification when your article is published.
            </Text>
          </Stack>
        ),
        labels: { cancel: 'Cancel', confirm: 'Continue' },
        confirmProps: { color: 'blue' },
        onConfirm: () => submitArticle({ status: ArticleStatus.Processing }),
      });
      return;
    }

    // No images or just saving draft, proceed normally
    submitArticle();
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <ReadOnlyAlert
        message={
          "Civitai is currently in read-only mode and you won't be able to publish or see changes made to this article."
        }
      />
      <ContainerGrid2 gutter="xl">
        <ContainerGrid2.Col span={{ base: 12, md: 8 }}>
          <Stack gap="xl">
            <Group gap={8} wrap="nowrap">
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
                'video',
                'polls',
                'colors',
              ]}
              withAsterisk
              stickyToolbar
            />
          </Stack>
        </ContainerGrid2.Col>
        <ContainerGrid2.Col span={{ base: 12, md: 4 }}>
          <Stack
            style={{
              position: 'sticky',
              top: 'calc(var(--header-height) + var(--mantine-spacing-md))',
            }}
            gap="xl"
          >
            {article?.id && article.status === ArticleStatus.Processing && (
              <ArticleScanStatus
                articleId={article.id}
                onComplete={() => queryUtils.article.getById.invalidate({ id: article.id })}
              />
            )}
            <ActionButtons
              article={article}
              currentContent={content as string}
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
              className="hidden @sm:flex"
            />
            <InputSelect
              name="userNsfwLevel"
              data={browsingLevelSelectOptions}
              label={
                <Group gap={4} wrap="nowrap">
                  Maturity Level
                  <LegacyActionIcon
                    radius="xl"
                    size="xs"
                    variant="outline"
                    color="gray"
                    onClick={openBrowsingLevelGuide}
                  >
                    <IconQuestionMark size={18} />
                  </LegacyActionIcon>
                  <ContentPolicyLink size="xs" variant="text" c="dimmed" td="underline" />
                </Group>
              }
            />
            <InputSimpleImageUpload
              name="coverImage"
              label="Cover Image"
              description={`Suggested resolution: ${constants.article.coverImageWidth} x ${constants.article.coverImageHeight}`}
              withAsterisk
            />
            <InputSelect
              name="categoryId"
              label={
                <Group gap={4} wrap="nowrap">
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
              nothingFoundMessage="Nothing found"
              loading={loadingCategories}
            />
            <InputTags
              name="tags"
              label={
                <Group gap={4} wrap="nowrap">
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
                <Group gap={4} wrap="nowrap">
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
                  <Group justify="space-between">
                    {article && file.id ? (
                      <Anchor href={`/api/download/attachments/${file.id}`} lineClamp={1} download>
                        {file.name}
                      </Anchor>
                    ) : (
                      <Text size="sm" fw={500} lineClamp={1}>
                        {file.name}
                      </Text>
                    )}
                    <Tooltip label="Remove">
                      <LegacyActionIcon
                        size="sm"
                        color="red"
                        variant="transparent"
                        onClick={onRemove}
                      >
                        <IconTrash />
                      </LegacyActionIcon>
                    </Tooltip>
                  </Group>
                </Paper>
              )}
            />
            <UploadNotice className="-mt-2" />
            <ActionButtons
              article={article}
              currentContent={content as string}
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
              className="@sm:hidden"
            />
          </Stack>
        </ContainerGrid2.Col>
      </ContainerGrid2>
    </Form>
  );
}

type Props = { article?: ArticleGetById };

function ActionButtons({
  article,
  currentContent,
  saveButtonProps,
  publishButtonProps,
  ...stackProps
}: ActionButtonProps) {
  // Get scan status for articles in Processing state
  const { status: scanStatus } = useArticleScanStatus({
    articleId: article?.id ?? 0,
    enabled: !!article?.id && article.status === ArticleStatus.Processing,
  });

  // Extract images from current editor content (memoized to avoid re-parsing on every render)
  const currentContentUrls = useMemo(() => {
    if (!currentContent) return new Set<string>();
    const images = extractImagesFromArticle(currentContent ?? '');
    return new Set(images.map((img) => img.url));
  }, [currentContent]);

  // Check if problematic images are STILL in current content (memoized)
  const hasProblematicImages = useMemo(() => {
    if (!scanStatus || (scanStatus.blocked === 0 && scanStatus.error === 0)) {
      return false;
    }

    const problematicImages = [
      ...(scanStatus.images?.blocked || []),
      ...(scanStatus.images?.error || []),
    ];

    return problematicImages.some((img) => currentContentUrls.has(img.url));
  }, [scanStatus, currentContentUrls]);

  const publishDisabled = publishButtonProps.disabled || hasProblematicImages;

  // Memoize tooltip label to avoid string concatenation on every render
  const publishTooltipLabel = useMemo(() => {
    if (!hasProblematicImages || !scanStatus) return undefined;

    const parts: string[] = [];
    if (scanStatus.blocked > 0) {
      parts.push(`${scanStatus.blocked} image(s) blocked (policy violation)`);
    }
    if (scanStatus.error > 0) {
      parts.push(`${scanStatus.error} image(s) failed to scan`);
    }

    return `Cannot publish: ${parts.join(' and ')}. Please remove or replace these images.`;
  }, [hasProblematicImages, scanStatus]);

  return (
    <Stack {...stackProps} gap={8}>
      {article?.publishedAt ? (
        <Tooltip
          label={publishTooltipLabel}
          disabled={!hasProblematicImages || article.status === ArticleStatus.Published}
          {...tooltipProps}
        >
          <Button
            {...(article.status !== ArticleStatus.Published ? publishButtonProps : saveButtonProps)}
            disabled={
              article.status !== ArticleStatus.Published
                ? publishDisabled
                : saveButtonProps.disabled
            }
            type="submit"
            fullWidth
          >
            {article.status !== ArticleStatus.Published ? 'Publish' : 'Save'}
          </Button>
        </Tooltip>
      ) : (
        <>
          <Button {...saveButtonProps} type="submit" variant="default" fullWidth>
            Save Draft
          </Button>
          <Tooltip label={publishTooltipLabel} disabled={!hasProblematicImages} {...tooltipProps}>
            <Button {...publishButtonProps} disabled={publishDisabled} type="submit" fullWidth>
              Publish
            </Button>
          </Tooltip>
        </>
      )}
      {article?.publishedAt ? (
        <Text size="xs" c="dimmed">
          Published at {formatDate(article.publishedAt)}
        </Text>
      ) : (
        <Text size="xs" c="dimmed">
          Your article is currently{' '}
          <Tooltip
            label="Click the publish button to make your article public to share with the Civitai community for comments and reactions."
            {...tooltipProps}
          >
            <Text td="underline" span inherit>
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
  currentContent?: string;
};
