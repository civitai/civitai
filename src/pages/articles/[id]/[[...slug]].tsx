import {
  Badge,
  Box,
  Button,
  Container,
  Divider,
  Grid,
  Group,
  Stack,
  Text,
  Title,
  createStyles,
} from '@mantine/core';
import { ArticleEngagementType } from '@prisma/client';
import { IconBookmark, IconShare3 } from '@tabler/icons-react';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import React from 'react';
import { z } from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
import { Sidebar } from '~/components/Article/Detail/Sidebar';
import { ToggleArticleEngagement } from '~/components/Article/ToggleArticleEngagement';
import { Collection } from '~/components/Collection/Collection';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
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
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.articles) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) await ssg.article.getById.prefetch({ id: result.data.id });

    return { props: removeEmpty(result.data) };
  },
});

export default function ArticleDetailsPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const mobile = useIsMobile();

  const { data: article, isLoading } = trpc.article.getById.useQuery({ id });

  // TODO.articles: add meta description
  const meta = (
    <Meta
      title={`Civitai | ${article?.title}`}
      image={
        article?.nsfw || article?.cover == null
          ? undefined
          : getEdgeUrl(article.cover, { width: 1200 })
      }
    />
  );

  if (isLoading) return <PageLoader />;
  if (!article) return <NotFound />;

  if (article.nsfw && !currentUser)
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );

  const category = article.tags.find((tag) => tag.isCategory);
  const tags = article.tags.filter((tag) => !tag.isCategory);

  const actionButtons = (
    <Group spacing={4} noWrap>
      <LoginRedirect reason="favorite-model">
        <ToggleArticleEngagement articleId={article.id}>
          {({ toggle, isToggled }) => {
            const isFavorite = isToggled?.Favorite;
            return (
              <IconBadge
                radius="sm"
                color="gray"
                size="lg"
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
        <Button
          variant="subtle"
          color="gray"
          sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
        >
          <IconShare3 />
        </Button>
      </ShareButton>
    </Group>
  );

  return (
    <>
      {meta}
      <TrackView entityId={article.id} entityType="Article" type="ArticleView" />
      <Container size="xl">
        <Stack spacing={0} mb="xl">
          <Group position="apart" noWrap>
            <Title weight="bold" className={classes.title}>
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
                  height: 'calc(100vh / 3)',
                  '& > img': { height: '100%', objectFit: 'cover', borderRadius: theme.radius.md },
                })}
              >
                <EdgeImage src={article.cover} width={1320} />
              </Box>
              <article>
                <RenderHtml html={article.content} />
              </article>
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
                />
                {actionButtons}
              </Group>
            </Stack>
          </Grid.Col>
          <Grid.Col xs={12} md={3} offsetMd={1}>
            <Sidebar creator={article.user} attachments={article.attachments} />
          </Grid.Col>
        </Grid>

        <Title order={2} id="comments" my="xl">
          Comments
        </Title>
        {article.user && <ArticleDetailComments articleId={article.id} userId={article.user.id} />}
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  titleWrapper: {
    gap: theme.spacing.xs,

    [theme.fn.smallerThan('md')]: {
      gap: theme.spacing.xs * 0.4,
    },
  },

  title: {
    wordBreak: 'break-word',
    [theme.fn.smallerThan('md')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
      width: '100%',
      paddingBottom: 0,
    },
  },

  badgeText: {
    fontSize: theme.fontSizes.md,
    [theme.fn.smallerThan('md')]: {
      fontSize: theme.fontSizes.sm,
    },
  },
}));
