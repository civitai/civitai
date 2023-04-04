import { Container, Stack, Title, Group, Badge } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { trpc } from '~/utils/trpc';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { PostImages } from '~/components/Post/Detail/PostImages';
import Router from 'next/router';
import { useEffect } from 'react';
import { QS } from '~/utils/qs';
import { Meta } from '~/components/Meta/Meta';
import { truncate } from 'lodash-es';
import { removeTags } from '~/utils/string-helpers';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

export function PostDetail({ postId }: { postId: number }) {
  const { data: post, isLoading: postLoading } = trpc.post.get.useQuery({ id: postId });
  const { data: { items: images } = { items: [] }, isLoading: imagesLoading } =
    trpc.image.getInfinite.useQuery({ postId });

  // when a user navigates back in their browser, set the previous url with the query string post={postId}
  useEffect(() => {
    Router.beforePopState(({ as, url }) => {
      if (as === '/posts' || as.startsWith('/posts?')) {
        const [route, queryString] = as.split('?');
        const [, otherQueryString] = url.split('?');
        const queryParams = QS.parse(queryString);
        const otherParams = QS.parse(otherQueryString);
        Router.replace(
          { pathname: route, query: { ...queryParams, ...otherParams, post: postId } },
          as,
          { shallow: true }
        );
        return false;
      }
      return true;
    });

    return () => Router.beforePopState(() => true);
  }, [postId]); // Add any state variables to dependencies array if needed.

  if (postLoading) return <PageLoader />;
  if (!post) return <NotFound />;

  return (
    <>
      <Meta
        title={post.title ?? `Image post by ${post.user.username}`}
        description={truncate(removeTags(post.detail ?? ''), { length: 150 })}
        image={images[0]?.url == null ? undefined : getEdgeUrl(images[0].url, { width: 1200 })}
      />
      <Container size="sm">
        <Stack>
          <Group position="apart" noWrap align="top">
            {post.title ? (
              <Title sx={{ lineHeight: 1 }} order={2}>
                {post.title}
              </Title>
            ) : (
              <span></span>
            )}
            <PostControls postId={post.id} userId={post.user.id} />
          </Group>

          <PostImages postId={post.id} images={images} isLoading={imagesLoading} />
          <Stack spacing="xl">
            {!!post.tags.length && (
              <Group spacing="xs">
                {post.tags.map((tag) => (
                  <Badge key={tag.id} size="lg">
                    {tag.name}
                  </Badge>
                ))}
              </Group>
            )}
            {post.detail && <RenderHtml html={post.detail} withMentions />}
            <a id="comments" />
            <PostComments postId={postId} userId={post.user.id} />
          </Stack>
        </Stack>
      </Container>
    </>
  );
}
