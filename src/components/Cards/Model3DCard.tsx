import { Badge, Group, Stack, Text } from '@mantine/core';
import { IconCube, IconStar } from '@tabler/icons-react';
import { memo } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

/**
 * Card item in the /3d-models feed. Stripped-down Model3D analog of `ModelCard`
 * — no civitai-link / tipping / remix surfaces (Phase 2 territory). Renders
 * thumbnail, name, creator, and a couple of light badges.
 */

type Model3DListItem = inferRouterOutputs<AppRouter>['model3d']['getInfinite']['items'][number];

type Props = { data: Model3DListItem };

export const Model3DCard = memo(function Model3DCard({ data }: Props) {
  const {
    id,
    name,
    thumbnailImage,
    user,
    nsfw,
    nsfwLevel,
    metric,
  } = data;

  const ratingAvg = metric?.ratingAvg ?? 0;
  const ratingCount = metric?.ratingCount ?? 0;

  return (
    <AspectRatioImageCard
      href={`/3d-models/${id}`}
      // TODO(model3d): add 'model3d' to ConnectType in ImageGuard2 once we wire
      // the image-guard pipeline for Model3D thumbnails. For now we skip the
      // connection — the card just renders the thumbnail without per-card
      // unblur tracking.
      aspectRatio="portrait"
      image={
        thumbnailImage
          ? {
              id: thumbnailImage.id,
              url: thumbnailImage.url,
              type: thumbnailImage.type,
              name: thumbnailImage.name,
              metadata: (thumbnailImage.metadata ?? null) as Record<string, unknown> | null,
              width: thumbnailImage.width,
              height: thumbnailImage.height,
              hash: thumbnailImage.hash,
              userId: thumbnailImage.userId,
              nsfwLevel: thumbnailImage.nsfwLevel ?? nsfwLevel,
            }
          : undefined
      }
      header={
        <Group gap={4} justify="space-between" wrap="nowrap" className="w-full">
          <Badge
            size="sm"
            radius="sm"
            color="violet"
            variant="filled"
            leftSection={<IconCube size={12} stroke={2.2} />}
          >
            3D
          </Badge>
          {nsfw && (
            <Badge size="sm" radius="sm" color="red" variant="filled">
              NSFW
            </Badge>
          )}
        </Group>
      }
      footer={
        <Stack gap={4} className="w-full">
          <Text size="sm" fw={600} c="white" lineClamp={2}>
            {name}
          </Text>
          <Group gap="xs" justify="space-between" wrap="nowrap">
            <UserAvatarSimple
              id={user.id}
              username={user.username}
              profilePicture={user.profilePicture}
              deletedAt={user.deletedAt}
              cosmetics={user.cosmetics}
            />
            {ratingCount > 0 && (
              <Group gap={2} wrap="nowrap">
                <IconStar size={12} stroke={2} fill="currentColor" color="#facc15" />
                <Text size="xs" c="white">
                  {ratingAvg.toFixed(1)}
                  <Text component="span" c="dimmed" ml={2}>
                    ({ratingCount})
                  </Text>
                </Text>
              </Group>
            )}
          </Group>
        </Stack>
      }
      footerGradient
    />
  );
});
