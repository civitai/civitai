import { Button, Card, Center, Group, Loader, Stack, Text, Title, Tooltip } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import { IconPlus, IconUsers } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * MakesUsesRail
 *
 * Renders community Posts linked to a Model3D via `Post.model3dId`, excluding
 * the creator's own auto-Post (the generation thumbnail Post). Each card shows
 * the first image of the Post, the user's avatar, and the Post title.
 *
 * Also surfaces an "Add Post" CTA so any logged-in user can contribute their
 * own images. Routes to `/posts/create?model3dId=…&returnUrl=…`; the post-edit
 * flow accepts `model3dId` end-to-end (postEditQuerySchema → PostImageDropzone
 * → post.create), binding the resulting Post to this 3D model.
 *
 * Backed by `trpc.model3d.getRelatedPosts` — workstream G addition.
 */

type MakesUsesRailProps = {
  model3dId: number;
};

export function MakesUsesRail({ model3dId }: MakesUsesRailProps) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.model3d.getRelatedPosts.useQuery(
    { model3dId, limit: 12 },
    { placeholderData: keepPreviousData }
  );

  const items = data?.items ?? [];
  const isMuted = currentUser?.muted ?? false;

  const handleAddPostClick = () => {
    const returnUrl = router.asPath;
    router.push(`/posts/create?model3dId=${model3dId}&returnUrl=${encodeURIComponent(returnUrl)}`);
  };

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <IconUsers size={20} />
            <Title order={3}>Makes &amp; Uses</Title>
          </Group>
          {!isMuted && (
            <Tooltip label="Share images of what you made with this 3D model" withinPortal>
              <LoginRedirect reason="post-images">
                <Button
                  size="xs"
                  variant="outline"
                  leftSection={<IconPlus size={14} />}
                  onClick={handleAddPostClick}
                >
                  Add Post
                </Button>
              </LoginRedirect>
            </Tooltip>
          )}
        </Group>

        {isLoading ? (
          <Center p="lg">
            <Loader size="sm" />
          </Center>
        ) : items.length === 0 ? (
          <Stack gap="xs" align="flex-start">
            <Text c="dimmed" size="sm">
              No community posts yet. Share an image of what you made with this 3D model
              to be the first.
            </Text>
            {!isMuted && (
              <LoginRedirect reason="post-images">
                <Button
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  onClick={handleAddPostClick}
                >
                  Add the first post
                </Button>
              </LoginRedirect>
            )}
          </Stack>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((post) => {
              const image = post.images[0];
              return (
                <Link
                  key={post.id}
                  href={`/posts/${post.id}`}
                  className="block overflow-hidden rounded-md border border-solid border-dark-4 transition-colors hover:border-blue-5"
                >
                  <div className="relative aspect-square w-full bg-dark-7">
                    {image ? (
                      <EdgeMedia
                        src={image.url}
                        type={image.type}
                        name={image.name}
                        width={450}
                        anim={false}
                        className="size-full object-cover"
                      />
                    ) : (
                      <Center className="size-full">
                        <Text size="xs" c="dimmed">
                          No image
                        </Text>
                      </Center>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 p-2">
                    <UserAvatarSimple {...post.user} />
                    {post.title && (
                      <Text size="sm" lineClamp={2} fw={500}>
                        {post.title}
                      </Text>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Stack>
    </Card>
  );
}

export default MakesUsesRail;
