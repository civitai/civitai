import {
  ActionIcon,
  Anchor,
  Badge,
  CloseButton,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons';
import { truncate } from 'lodash-es';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { PostImages } from '~/components/Post/Detail/PostImages';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { daysFromNow } from '~/utils/date-helpers';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function PostDetail({ postId }: { postId: number }) {
  const router = useRouter();
  const { data: post, isLoading: postLoading } = trpc.post.get.useQuery({ id: postId });
  const { data: { items: images } = { items: [] }, isLoading: imagesLoading } =
    trpc.image.getInfinite.useQuery({ postId });
  const { data: postResources = [], isLoading: loadingResources } = trpc.post.getResources.useQuery(
    { id: postId }
  );

  if (postLoading) return <PageLoader />;
  if (!post) return <NotFound />;

  const relatedResource = postResources.find(
    (resource) => resource.modelVersionId === post.modelVersionId
  );

  return (
    <>
      <Meta
        title={post.title ?? `Image post by ${post.user.username}`}
        description={truncate(removeTags(post.detail ?? ''), { length: 150 })}
        image={images[0]?.url == null ? undefined : getEdgeUrl(images[0].url, { width: 1200 })}
      />
      <Container size="sm">
        <Stack>
          <Stack spacing={4}>
            <Group position="apart" noWrap align="top">
              {post.title ? (
                <Title sx={{ lineHeight: 1 }} order={2}>
                  {post.title}
                </Title>
              ) : (
                <span></span>
              )}
              <Group spacing="xs">
                <PostControls postId={post.id} userId={post.user.id}>
                  <ActionIcon variant="outline">
                    <IconDotsVertical size={16} />
                  </ActionIcon>
                </PostControls>
                {router.query.modal && (
                  <NavigateBack url="/posts">
                    {({ onClick }) => <CloseButton onClick={onClick} size="lg" />}
                  </NavigateBack>
                )}
              </Group>
            </Group>
            {relatedResource && (
              <Text size="sm" color="dimmed">
                Posted to{' '}
                <Link
                  href={`/models/${relatedResource.modelId}?modelVersionId=${relatedResource.modelVersionId}`}
                  passHref
                >
                  <Anchor>
                    {relatedResource.modelName} - {relatedResource.modelVersionName}
                  </Anchor>
                </Link>{' '}
                {post.publishedAt ? daysFromNow(post.publishedAt) : null}
              </Text>
            )}
          </Stack>

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
