import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  CloseButton,
  Container,
  Divider,
  Group,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { IconDotsVertical, IconPlaylistAdd, IconShare3 } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import Link from 'next/link';
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
import { Collection } from '~/components/Collection/Collection';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { openContext } from '~/providers/CustomModalsProvider';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { env } from '~/env/client.mjs';
import { toStringList } from '~/utils/array-helpers';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ClubRequirementIndicator, ClubRequirementNotice } from '../../Club/ClubRequirementNotice';

export function PostDetail({ postId }: { postId: number }) {
  const currentUser = useCurrentUser();
  const { query } = useBrowserRouter();
  const theme = useMantineTheme();
  const { data: post, isLoading: postLoading } = trpc.post.get.useQuery({ id: postId });
  const { images, isLoading: imagesLoading } = useQueryImages(
    { postId, limit: post?.hasAccess ? undefined : 1 },
    // Haivng this be enabled only when the post is available is a bit slower for the user
    // but prevents users with no access from looking at all the images in the post
    { enabled: !!post }
  );
  const { data: postResources = [] } = trpc.post.getResources.useQuery({ id: postId });

  const meta = (
    <Meta
      title={(post?.title ?? `Image post by ${post?.user.username}`) + ' | Civitai'}
      description={
        `A post by ${post?.user.username}. Tagged with ${toStringList(
          post?.tags.map((x) => x.name) ?? []
        )}.` + (post?.detail ? ' ' + truncate(removeTags(post?.detail ?? ''), { length: 100 }) : '')
      }
      image={
        post?.nsfw || images[0]?.url == null
          ? undefined
          : getEdgeUrl(images[0].url, { width: 1200 })
      }
      links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/posts/${postId}`, rel: 'canonical' }]}
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
      <Container size="md">
        <Stack>
          <Stack spacing={8}>
            <Group spacing="md" position="apart" align="center" noWrap>
              {post.title && (
                <Title order={1} lineClamp={2} size={26}>
                  {post.title}
                </Title>
              )}
              {query.dialog && (
                <NavigateBack url="/posts">
                  {({ onClick }) => <CloseButton onClick={onClick} size="lg" ml="auto" />}
                </NavigateBack>
              )}
            </Group>
            <Group position="apart" align="flex-start">
              <Group spacing="sm">
                <Text size="xs" color="dimmed">
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
                </Text>
                {!!post.tags.length && (
                  <>
                    <Divider
                      orientation="vertical"
                      sx={(theme) => ({ [containerQuery.smallerThan('sm')]: { display: 'none' } })}
                    />
                    <Collection
                      items={post.tags}
                      limit={2}
                      badgeProps={{ radius: 'xl', size: 'lg' }}
                      renderItem={(item) => (
                        <Link key={item.id} href={`/posts?tags=${item.id}&view=feed`} passHref>
                          <Badge
                            component="a"
                            color="gray"
                            radius="xl"
                            size="lg"
                            px={8}
                            style={{ cursor: 'pointer' }}
                            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                          >
                            <Text size="xs" transform="capitalize" weight={500}>
                              {item.name}
                            </Text>
                          </Badge>
                        </Link>
                      )}
                      grouped
                    />
                  </>
                )}
              </Group>
              <Group spacing="xs" position="right" sx={{ flex: '1 0 !important' }} noWrap>
                <ClubRequirementIndicator
                  entityId={post.id}
                  entityType="Post"
                  radius="xl"
                  size="md"
                />
                <Button
                  size="md"
                  radius="xl"
                  color="gray"
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  leftIcon={<IconPlaylistAdd size={14} />}
                  onClick={() =>
                    openContext('addToCollection', {
                      postId: post.id,
                      type: CollectionType.Post,
                    })
                  }
                  compact
                >
                  <Text size="xs">Save</Text>
                </Button>
                <ShareButton
                  url={`/posts/${post.id}`}
                  title={post.title ?? `Post by ${post.user.username}`}
                  collect={{ type: CollectionType.Post, postId: post.id }}
                >
                  <Button
                    radius="xl"
                    color="gray"
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    size="md"
                    leftIcon={<IconShare3 size={14} />}
                    compact
                  >
                    <Text size="xs">Share</Text>
                  </Button>
                </ShareButton>
                <PostControls
                  postId={post.id}
                  userId={post.user.id}
                  isModelVersionPost={post.modelVersionId}
                >
                  <ActionIcon
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    size={30}
                    radius="xl"
                    sx={(theme) => ({ [containerQuery.smallerThan('sm')]: { marginLeft: 'auto' } })}
                  >
                    <IconDotsVertical size={16} />
                  </ActionIcon>
                </PostControls>
              </Group>
            </Group>
            <Group spacing="xl" mt="sm">
              <UserAvatar
                user={post.user}
                avatarProps={{ size: 32 }}
                size="md"
                subTextSize="sm"
                textSize="md"
                withUsername
                linkToProfile
              />
              <Group spacing={8} noWrap>
                <TipBuzzButton
                  toUserId={post.user.id}
                  entityId={post.id}
                  entityType="Post"
                  size="md"
                  compact
                />
                <FollowUserButton userId={post.user.id} size="md" compact />
              </Group>
            </Group>
            <ClubRequirementNotice entityId={post.id} entityType="Post" />
          </Stack>
          <Container size="sm">
            <PostImages postId={post.id} images={images} isLoading={imagesLoading} />
            <Stack spacing="xl" mt="xl" id="comments">
              {post.detail && <RenderHtml html={post.detail} withMentions />}
              <PostComments postId={postId} userId={post.user.id} />
            </Stack>
          </Container>
        </Stack>
      </Container>
    </>
  );
}
