import { Container, Stack, Title, Group, Badge } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { trpc } from '~/utils/trpc';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { PostImages } from '~/components/Post/Detail/PostImages';

export function PostDetail({ postId }: { postId: number }) {
  const { data: post, isLoading: postLoading } = trpc.post.get.useQuery({ id: postId });

  if (postLoading) return <PageLoader />;
  if (!post) return <NotFound />;

  return (
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

        <PostImages postId={postId} />
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
          <PostComments postId={postId} userId={post.user.id} />
        </Stack>
      </Stack>
    </Container>
  );
}
