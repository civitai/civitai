import {
  Anchor,
  AspectRatio,
  Badge,
  Box,
  Center,
  Container,
  Divider,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { getHotkeyHandler } from '@mantine/hooks';
import { IconAlertCircle, IconBolt, IconBookmark, IconShare3 } from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import { truncate } from 'lodash-es';
import type { InferGetServerSidePropsType } from 'next';
import React, { useMemo } from 'react';
import * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
import { Sidebar } from '~/components/Article/Detail/Sidebar';
import { ToggleArticleEngagement } from '~/components/Article/ToggleArticleEngagement';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { Collection } from '~/components/Collection/Collection';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageViewer, useImageViewerCtx } from '~/components/ImageViewer/ImageViewer';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ArticleEngagementType, ArticleStatus, Availability } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { removeTags, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import classes from './[[...slug]].module.scss';
import { RenderRichText } from '~/components/RichTextEditor/RenderRichText';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg }) => {
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      await ssg.article.getById.prefetch({ id: result.data.id });
      await ssg.hiddenPreferences.getHidden.prefetch();
    }

    return { props: removeEmpty(result.data) };
  },
});

const MAX_WIDTH = 1320;

function ArticleDetailsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const currentUser = useCurrentUser();
  const mobile = useContainerSmallerThan('sm');
  const { setImages, onSetImage, images } = useImageViewerCtx();
  const { articles } = useFeatureFlags();

  const { data: article, isLoading, isRefetching } = trpc.article.getById.useQuery({ id });
  const tippedAmount = useBuzzTippingStore({ entityType: 'Article', entityId: id });

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === article?.user.id);
  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === article?.user?.id || isModerator;

  // boolean value that allows us to disable articles via feature flags and still allow us to show articles created by moderators
  const disableArticles = !articles && !article?.user.isModerator;

  const queryUtils = trpc.useUtils();
  const upsertArticleMutation = trpc.article.upsert.useMutation();
  const handlePublishArticle = () => {
    if (!article || article.status === ArticleStatus.Published) return;

    upsertArticleMutation.mutate(
      { ...article, status: ArticleStatus.Published },
      {
        async onSuccess() {
          await queryUtils.article.getById.invalidate({ id });
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to publish article',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  const memoizedImageData = useMemo(
    () => [article?.coverImage].filter(isDefined),
    [article?.coverImage]
  );
  const { items } = useApplyHiddenPreferences({
    type: 'images',
    data: memoizedImageData,
  });
  const [image] = items;
  if (image && !images.length) setImages([image]);

  if (isLoading) return <PageLoader />;
  if (!article || isBlocked || disableArticles) return <NotFound />;

  const category = article.tags.find((tag) => tag.isCategory);
  const tags = article.tags.filter((tag) => !tag.isCategory);

  const actionButtons = (
    <Group gap={4} align="center" wrap="nowrap">
      <InteractiveTipBuzzButton toUserId={article.user.id} entityType="Article" entityId={id}>
        <IconBadge
          radius="sm"
          style={{ cursor: 'pointer' }}
          color="gray"
          size="lg"
          h={28}
          icon={<IconBolt />}
        >
          <Text className={classes.badgeText}>
            {abbreviateNumber((article.stats?.tippedAmountCountAllTime ?? 0) + tippedAmount)}
          </Text>
        </IconBadge>
      </InteractiveTipBuzzButton>
      <LoginRedirect reason="favorite-article">
        <ToggleArticleEngagement articleId={article.id}>
          {({ toggle, isToggled }) => {
            const isFavorite = isToggled?.Favorite;
            return (
              <IconBadge
                radius="sm"
                color="gray"
                size="lg"
                h={28}
                icon={
                  <IconBookmark
                    color={isFavorite ? theme.colors.gray[2] : undefined}
                    style={{ fill: isFavorite ? theme.colors.gray[2] : undefined }}
                  />
                }
                style={{ cursor: 'pointer' }}
                onClick={() => toggle(ArticleEngagementType.Favorite)}
              >
                <Text className={classes.badgeText}>
                  {abbreviateNumber(article.stats?.collectedCountAllTime ?? 0)}
                </Text>
              </IconBadge>
            );
          }}
        </ToggleArticleEngagement>
      </LoginRedirect>
      <ShareButton url={`/articles/${article.id}/${slugit(article.title)}`} title={article.title}>
        <LegacyActionIcon variant="subtle" color="gray">
          <IconShare3 />
        </LegacyActionIcon>
      </ShareButton>
    </Group>
  );

  const handleOpenCoverImage =
    (imageId: number) => (e: React.KeyboardEvent<HTMLElement> | KeyboardEvent) => {
      e.preventDefault();
      onSetImage(imageId);
    };

  return (
    <>
      <Meta
        title={`${article.title} | Civitai`}
        description={truncate(removeTags(article.content), { length: 150 })}
        images={article?.coverImage}
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [
                {
                  href: `${env.NEXT_PUBLIC_BASE_URL}/articles/${article.id}/${slugit(
                    article.title
                  )}`,
                  rel: 'canonical',
                },
                {
                  href: `${env.NEXT_PUBLIC_BASE_URL}/articles/${article.id}`,
                  rel: 'alternate',
                },
              ]
            : []
        }
        deIndex={!article?.publishedAt || article?.availability === Availability.Unsearchable}
      />
      <SensitiveShield contentNsfwLevel={article.nsfwLevel}>
        <TrackView entityId={article.id} entityType="Article" type="ArticleView" />
        <Container size="xl" pos="relative">
          <LoadingOverlay visible={isRefetching || upsertArticleMutation.isLoading} />
          <Stack gap={8} mb="xl">
            <Group justify="space-between" wrap="nowrap">
              <Title fw="bold" className={classes.title} order={1}>
                {article.title}
              </Title>
              <Group align="center" className={classes.titleWrapper} wrap="nowrap">
                {!mobile && actionButtons}
                <ArticleContextMenu article={article} />
              </Group>
            </Group>
            <Group gap={8}>
              <UserAvatar user={article.user} withUsername linkToProfile />
              <Divider orientation="vertical" />
              <Text c="dimmed" size="sm">
                {article.publishedAt ? formatDate(article.publishedAt) : 'Draft'}
              </Text>
              {article.publishedAt &&
                article.updatedAt &&
                dayjs(article.updatedAt) > dayjs(article.publishedAt).add(1, 'hour') && (
                  <Tooltip label={formatDate(article.updatedAt, 'MMM D, YYYY hh:mm:ss A')}>
                    <Text size="sm" c="dimmed" className="cursor-default">
                      (Updated: {dayjs().to(dayjs(article.updatedAt))})
                    </Text>
                  </Tooltip>
                )}
              {category && (
                <>
                  <Divider orientation="vertical" />
                  <Link legacyBehavior href={`/articles?view=feed&tags=${category.id}`} passHref>
                    <Badge
                      component="a"
                      size="sm"
                      variant="gradient"
                      gradient={{ from: 'cyan', to: 'blue' }}
                      style={{ cursor: 'pointer' }}
                    >
                      {category.name}
                    </Badge>
                  </Link>
                </>
              )}
              {!!tags.length && (
                <>
                  <Divider orientation="vertical" />
                  <Collection
                    items={tags}
                    renderItem={(tag) => (
                      <Link
                        legacyBehavior
                        key={tag.id}
                        href={`/articles?view=feed&tags=${tag.id}`}
                        passHref
                      >
                        <Badge
                          component="a"
                          color="gray"
                          variant={colorScheme === 'dark' ? 'filled' : undefined}
                          style={{ cursor: 'pointer' }}
                        >
                          {tag.name}
                        </Badge>
                      </Link>
                    )}
                    grouped
                  />
                </>
              )}
            </Group>
            {article.status === ArticleStatus.Unpublished && isOwner && (
              <AlertWithIcon size="lg" icon={<IconAlertCircle />} color="yellow" iconColor="yellow">
                <div>
                  This article has been unpublished.{' '}
                  <Anchor component="button" className="inline-flex" onClick={handlePublishArticle}>
                    Click here
                  </Anchor>{' '}
                  to publish it again or make changes to it before publishing.
                </div>
              </AlertWithIcon>
            )}
          </Stack>
          <ContainerGrid2 gutter="xl">
            <ContainerGrid2.Col span={{ base: 12, sm: 8 }}>
              <Stack gap="xs">
                {image && (
                  <AspectRatio
                    ratio={constants.article.coverImageWidth / constants.article.coverImageHeight}
                  >
                    <Box
                      role="button"
                      tabIndex={0}
                      onClick={() => onSetImage(image.id)}
                      onKeyDown={getHotkeyHandler([
                        ['Enter', handleOpenCoverImage(image.id)],
                        ['Space', handleOpenCoverImage(image.id)],
                      ])}
                      style={{ cursor: 'pointer' }}
                    >
                      <Center className="size-full">
                        <div className="relative size-full">
                          <ImageGuard2 image={image} connectType="article" connectId={article.id}>
                            {(safe) => (
                              <>
                                <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                                <ImageContextMenu
                                  image={image}
                                  noDelete={true}
                                  className="absolute right-2 top-2 z-10"
                                />
                                {!safe ? (
                                  <div className="relative h-full overflow-hidden rounded-lg object-cover">
                                    <MediaHash {...image} />
                                  </div>
                                ) : (
                                  <EdgeMedia
                                    src={image.url}
                                    className="h-full rounded-lg object-cover"
                                    name={image.name}
                                    alt={article.title}
                                    type={image.type}
                                    width={MAX_WIDTH}
                                    anim={safe}
                                  />
                                )}
                              </>
                            )}
                          </ImageGuard2>
                        </div>
                      </Center>
                    </Box>
                  </AspectRatio>
                )}

                {article.contentJson && (
                  <article>
                    <RenderRichText content={article.contentJson} />
                  </article>
                )}
                <Divider />
                <Group justify="space-between">
                  <Reactions
                    entityType="article"
                    reactions={article.reactions}
                    entityId={article.id}
                    metrics={{
                      likeCount: article.stats?.likeCountAllTime,
                      dislikeCount: article.stats?.dislikeCountAllTime,
                      heartCount: article.stats?.heartCountAllTime,
                      laughCount: article.stats?.laughCountAllTime,
                      cryCount: article.stats?.cryCountAllTime,
                    }}
                    targetUserId={article.user.id}
                  />
                  {actionButtons}
                </Group>
              </Stack>
            </ContainerGrid2.Col>
            <ContainerGrid2.Col span={{ base: 12, sm: 4 }}>
              <Sidebar
                creator={article.user}
                attachments={article.attachments}
                articleId={article.id}
              />
            </ContainerGrid2.Col>
          </ContainerGrid2>
          {article.id !== 13632 && (
            <ArticleDetailComments articleId={article.id} userId={article.user.id} />
          )}
        </Container>
      </SensitiveShield>
    </>
  );
}

export default Page(ArticleDetailsPage, {
  InnerLayout: ({ children }) => {
    return <ImageViewer>{children}</ImageViewer>;
  },
});
