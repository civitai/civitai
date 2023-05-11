import {
  Badge,
  Box,
  Container,
  Divider,
  Group,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import React from 'react';
import { z } from 'zod';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
import { Collection } from '~/components/Collection/Collection';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
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
  const theme = useMantineTheme();

  const { data: article, isLoading } = trpc.article.getById.useQuery({ id });

  // TODO.articles: add meta description
  const meta = <Meta title={`Civitai | ${article?.title}`} />;

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

  return (
    <>
      {meta}
      <TrackView entityId={article.id} entityType="Article" type="ArticleView" />
      <Container size="md">
        <Stack spacing="xl">
          <Stack spacing={0}>
            <Group position="apart" noWrap>
              <Title weight="bold">{article.title}</Title>
              {article.user && <ArticleContextMenu article={article} />}
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

          <Box
            sx={(theme) => ({
              height: 'calc(100vh / 3)',
              '& > img': { height: '100%', objectFit: 'cover', borderRadius: theme.radius.md },
            })}
          >
            <EdgeImage src={article.cover} width={1320} />
          </Box>
          <RenderHtml html={article.content} />
          <Divider />
          <Group position="apart" align="flex-start">
            <Reactions entityType="article" reactions={article.reactions} entityId={article.id} />
            <CreatorCard user={article.user} />
          </Group>
          <Title order={2}>Comments</Title>
          {article.user && (
            <ArticleDetailComments articleId={article.id} userId={article.user.id} />
          )}
        </Stack>
      </Container>
    </>
  );
}
