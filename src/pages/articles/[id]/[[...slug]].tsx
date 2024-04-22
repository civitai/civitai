import {
  ActionIcon,
  Badge,
  Box,
  Container,
  createStyles,
  Divider,
  Grid,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ArticleEngagementType, Availability } from '@prisma/client';
import { IconBolt, IconBookmark, IconShare3 } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import React from 'react';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
import { Sidebar } from '~/components/Article/Detail/Sidebar';
import { ToggleArticleEngagement } from '~/components/Article/ToggleArticleEngagement';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { Collection } from '~/components/Collection/Collection';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { removeTags, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { hasPublicBrowsingLevel } from '../../../shared/constants/browsingLevel.constants';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { ImageViewer, useImageViewerCtx } from '~/components/ImageViewer/ImageViewer';
import { ScrollAreaMain } from '~/components/ScrollArea/ScrollAreaMain';
import { getHotkeyHandler } from '@mantine/hooks';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.articles) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) await ssg.article.getById.prefetch({ id: result.data.id });

    return { props: removeEmpty(result.data) };
  },
});

const MAX_WIDTH = 1320;

export default function ArticleDetailsPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const mobile = useContainerSmallerThan('sm');
  const { setImages, onSetImage, images } = useImageViewerCtx();

  const { data: article, isLoading } = trpc.article.getById.useQuery({ id });
  const tippedAmount = useBuzzTippingStore({ entityType: 'Article', entityId: id });

  const meta = article ? (
    <Meta
      title={`${article.title} | Civitai`}
      description={truncate(removeTags(article.content), { length: 150 })}
      images={article?.coverImage}
      links={[
        {
          href: `${env.NEXT_PUBLIC_BASE_URL}/articles/${article.id}/${slugit(article.title)}`,
          rel: 'canonical',
        },
      ]}
      deIndex={!article?.publishedAt || article?.availability === Availability.Unsearchable}
    />
  ) : null;

  if (isLoading) return <PageLoader />;
  if (!article) return <NotFound />;

  if (!currentUser && !hasPublicBrowsingLevel(article.nsfwLevel))
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );

  const category = article.tags.find((tag) => tag.isCategory);
  const tags = article.tags.filter((tag) => !tag.isCategory);

  const actionButtons = (
    <Group spacing={4} align="center" noWrap>
      <InteractiveTipBuzzButton toUserId={article.user.id} entityType="Article" entityId={id}>
        <IconBadge
          radius="sm"
          sx={{ cursor: 'pointer' }}
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
                sx={{ cursor: 'pointer' }}
                onClick={() => toggle(ArticleEngagementType.Favorite)}
              >
                <Text className={classes.badgeText}>
                  {abbreviateNumber(article.stats?.favoriteCountAllTime ?? 0)}
                </Text>
              </IconBadge>
            );
          }}
        </ToggleArticleEngagement>
      </LoginRedirect>
      <ShareButton url={`/articles/${article.id}/${slugit(article.title)}`} title={article.title}>
        <ActionIcon variant="subtle" color="gray">
          <IconShare3 />
        </ActionIcon>
      </ShareButton>
    </Group>
  );

  const handleOpenCoverImage =
    (imageId: number) => (e: React.KeyboardEvent<HTMLElement> | KeyboardEvent) => {
      e.preventDefault();
      onSetImage(imageId);
    };

  const image = article.coverImage;
  if (image && !images.length) setImages([image]);

  return (
    <>
      {meta}
      <TrackView entityId={article.id} entityType="Article" type="ArticleView" />
      <Container size="xl">
        <Stack spacing={0} mb="xl">
          <Group position="apart" noWrap>
            <Title weight="bold" className={classes.title} order={1}>
              {article.title}
            </Title>
            <Group align="center" className={classes.titleWrapper} noWrap>
              {!mobile && actionButtons}
              <ArticleContextMenu article={article} />
            </Group>
          </Group>
          <Group spacing={8}>
            <UserAvatar user={article.user} withUsername linkToProfile />
            <Divider orientation="vertical" />
            <Text color="dimmed" size="sm">
              {article.publishedAt ? formatDate(article.publishedAt) : 'Draft'}
            </Text>
            {category && (
              <>
                <Divider orientation="vertical" />
                <Link href={`/articles?view=feed&tags=${category.id}`} passHref>
                  <Badge
                    component="a"
                    size="sm"
                    variant="gradient"
                    gradient={{ from: 'cyan', to: 'blue' }}
                    sx={{ cursor: 'pointer' }}
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
                    <Link key={tag.id} href={`/articles?view=feed&tags=${tag.id}`} passHref>
                      <Badge
                        component="a"
                        color="gray"
                        variant={theme.colorScheme === 'dark' ? 'filled' : undefined}
                        sx={{ cursor: 'pointer' }}
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
        </Stack>
        <Grid>
          <Grid.Col xs={12} md={8}>
            <Stack spacing="xs">
              <Box
                sx={(theme) => ({
                  position: 'relative',
                  height: 'calc(100vh / 3)',
                  'img, .hashWrapper': {
                    height: '100%',
                    objectFit: 'cover',
                    borderRadius: theme.radius.md,
                  },
                })}
              >
                {image && (
                  <ImageGuard2 image={image} connectType="article" connectId={article.id}>
                    {(safe) => (
                      <Box
                        role="button"
                        tabIndex={0}
                        onClick={() => onSetImage(image.id)}
                        onKeyDown={getHotkeyHandler([
                          ['Enter', handleOpenCoverImage(image.id)],
                          ['Space', handleOpenCoverImage(image.id)],
                        ])}
                        sx={{ cursor: 'pointer', height: '100%' }}
                      >
                        <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                        <ImageContextMenu image={image} className="absolute top-2 right-2 z-10" />
                        {!safe ? (
                          <div
                            className="hashWrapper"
                            style={{
                              position: 'relative',
                            }}
                          >
                            <MediaHash {...image} />
                          </div>
                        ) : (
                          <EdgeMedia
                            src={image.url}
                            name={image.name}
                            alt={article.title}
                            type={image.type}
                            width={MAX_WIDTH}
                            anim={safe}
                          />
                        )}
                      </Box>
                    )}
                  </ImageGuard2>
                )}
              </Box>
              {article.content && (
                <article>
                  <RenderHtml html={article.content} />
                </article>
              )}
              <Divider />
              <Group position="apart">
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
          </Grid.Col>
          <Grid.Col xs={12} md={4}>
            <Sidebar
              creator={article.user}
              attachments={article.attachments}
              articleId={article.id}
            />
          </Grid.Col>
        </Grid>
        <ArticleDetailComments articleId={article.id} userId={article.user.id} />
      </Container>
    </>
  );
}

setPageOptions(ArticleDetailsPage, {
  innerLayout({ children }) {
    return (
      <ImageViewer>
        <ScrollAreaMain>{children}</ScrollAreaMain>
      </ImageViewer>
    );
  },
});

const useStyles = createStyles((theme) => ({
  titleWrapper: {
    gap: theme.spacing.xs,

    [containerQuery.smallerThan('md')]: {
      gap: theme.spacing.xs * 0.4,
    },
  },

  title: {
    wordBreak: 'break-word',
    [containerQuery.smallerThan('md')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
      width: '100%',
      paddingBottom: 0,
    },
  },

  badgeText: {
    fontSize: theme.fontSizes.md,
    [containerQuery.smallerThan('md')]: {
      fontSize: theme.fontSizes.sm,
    },
  },
}));
