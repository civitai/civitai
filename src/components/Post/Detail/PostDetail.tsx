import {
  ActionIcon,
  Anchor,
  Badge,
  CloseButton,
  Container,
  Group,
  Stack,
  Title,
} from '@mantine/core';
import { IconDotsVertical, IconShare3 } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { useQueryImages } from '~/components/Image/image.utils';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { PostImages } from '~/components/Post/Detail/PostImages';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { CollectionType } from '@prisma/client';

export function PostDetail({ postId }: { postId: number }) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { data: post, isLoading: postLoading } = trpc.post.get.useQuery({ id: postId });
  const { images, isLoading: imagesLoading } = useQueryImages({ postId });
  const { data: postResources = [] } = trpc.post.getResources.useQuery({ id: postId });

  const meta = (
    <Meta
      title={post?.title ?? `Image post by ${post?.user.username}`}
      description={truncate(removeTags(post?.detail ?? ''), { length: 150 })}
      image={
        post?.nsfw || images[0]?.url == null
          ? undefined
          : getEdgeUrl(images[0].url, { width: 1200 })
      }
    />
  );

  if (postLoading) return <PageLoader />;
  if (!post) return <NotFound />;

  if (post.nsfw && !currentUser)
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );

  const relatedResource = postResources.find(
    (resource) => resource.modelVersionId === post.modelVersionId
  );

  return (
    <>
      {meta}
      <TrackView entityId={post.id} entityType="Post" type="PostView" />
      <Container size="sm">
        <Stack>
          <Stack spacing="xs">
            {post.title && (
              <Title sx={{ lineHeight: 1 }} order={2}>
                {post.title}
              </Title>
            )}
            <Group position="apart" noWrap>
              {!!post.tags.length ? (
                <Group spacing={4}>
                  {post.tags.map((tag) => (
                    <Badge key={tag.id} color="gray" variant="filled">
                      {tag.name}
                    </Badge>
                  ))}
                </Group>
              ) : (
                <div />
              )}
              <Group spacing="xs" noWrap>
                <ShareButton
                  url={`/posts/${post.id}`}
                  title={post.title ?? `Post by ${post.user.username}`}
                  collect={{ type: CollectionType.Post, postId: post.id }}
                >
                  <ActionIcon color="gray" variant="filled">
                    <IconShare3 size={16} />
                  </ActionIcon>
                </ShareButton>
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
            <UserAvatar
              user={post.user}
              size="md"
              subTextSize="sm"
              textSize="md"
              subText={
                <>
                  {relatedResource && (
                    <>
                      Posted to{' '}
                      <Link
                        href={`/models/${relatedResource.modelId}?modelVersionId=${relatedResource.modelVersionId}`}
                        passHref
                      >
                        <Anchor>
                          {relatedResource.modelName} - {relatedResource.modelVersionName}
                        </Anchor>
                      </Link>{' '}
                    </>
                  )}
                  {post.publishedAt ? <DaysFromNow date={post.publishedAt} /> : null}
                </>
              }
              withUsername
              linkToProfile
              subTextForce
            />
          </Stack>
          <PostImages postId={post.id} images={images} isLoading={imagesLoading} />
          <Stack spacing="xl" id="comments">
            {post.detail && <RenderHtml html={post.detail} withMentions />}
            <PostComments postId={postId} userId={post.user.id} />
          </Stack>
        </Stack>
      </Container>
    </>
  );
}
