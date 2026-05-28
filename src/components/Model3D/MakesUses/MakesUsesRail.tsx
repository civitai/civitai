import { Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { trpc } from '~/utils/trpc';

/**
 * MakesUsesRail
 *
 * Renders community Posts linked to a Model3D via `Post.model3dId`, excluding
 * the creator's own auto-Post (the generation thumbnail Post). Each card shows
 * the first image of the Post, the user's avatar, and the Post title.
 *
 * Backed by `trpc.model3d.getRelatedPosts` — workstream G addition.
 */

type MakesUsesRailProps = {
  model3dId: number;
};

export function MakesUsesRail({ model3dId }: MakesUsesRailProps) {
  const { data, isLoading } = trpc.model3d.getRelatedPosts.useQuery(
    { model3dId, limit: 12 },
    { keepPreviousData: true }
  );

  const items = data?.items ?? [];

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group gap="xs">
          <IconUsers size={20} />
          <Title order={3}>Makes &amp; Uses</Title>
        </Group>

        {isLoading ? (
          <Center p="lg">
            <Loader size="sm" />
          </Center>
        ) : items.length === 0 ? (
          <Text c="dimmed" size="sm">
            No community posts yet. Be the first to share how you used this 3D model.
          </Text>
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
