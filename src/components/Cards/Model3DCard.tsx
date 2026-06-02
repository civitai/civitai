import { ActionIcon, Badge, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconCube,
  IconDownload,
  IconEye,
  IconHeart,
  IconMessageCircle2,
  IconStar,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { memo, useState } from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';
import { trpc } from '~/utils/trpc';
import { abbreviateNumber } from '~/utils/number-helpers';

/**
 * Card item in the /3d-models feed.
 *
 * - NSFW handling via `AspectRatioImageCard` → `ImageGuard2` (blur by browsing
 *   level, canonical NSFW-level badge in header). Requires 'model3d' on the
 *   `ConnectType` union — added alongside this card.
 * - Reactions ride on the thumbnail Image (no `Model3DReaction` table per plan
 *   §6.15); `Model3DMetric.reactionCount` is the denormalized rollup, read here.
 * - "Preview" button overlays an inline GLB viewer (lazy-loaded three.js) over
 *   the thumbnail without leaving the feed. Resolves the primary file URL on
 *   demand via `trpc.model3d.getFiles`.
 */

const Model3DViewer = dynamic(
  () => import('~/components/Model3D/Viewer/Model3DViewer').then((m) => m.Model3DViewer),
  { ssr: false }
);

type Model3DListItem = inferRouterOutputs<AppRouter>['model3d']['getInfinite']['items'][number];

type Props = { data: Model3DListItem };

export const Model3DCard = memo(function Model3DCard({ data }: Props) {
  const { id, name, thumbnailImage, user, nsfwLevel, metric } = data;

  const [previewing, setPreviewing] = useState(false);
  const { data: filesData } = trpc.model3d.getFiles.useQuery(
    { id },
    { enabled: previewing, staleTime: 5 * 60_000 }
  );
  const primaryFile =
    filesData?.files.find((f) => f.isPrimary) ?? filesData?.files[0] ?? null;
  const previewUrl = primaryFile?.downloadUrl ?? primaryFile?.url ?? null;

  const downloadCount = metric?.downloadCount ?? 0;
  const commentCount = metric?.commentCount ?? 0;
  const reactionCount = metric?.reactionCount ?? 0;
  const ratingAvg = metric?.ratingAvg ?? 0;
  const ratingCount = metric?.ratingCount ?? 0;
  const hasStats = downloadCount > 0 || commentCount > 0 || reactionCount > 0;

  return (
    <Box pos="relative">
      <AspectRatioImageCard
        href={`/3d-models/${id}`}
        contentType="model3d"
        contentId={id}
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
              className={clsx(cardClasses.infoChip, cardClasses.chip)}
              variant="light"
              radius="xl"
              color="violet"
              leftSection={<IconCube size={12} stroke={2.2} />}
            >
              3D
            </Badge>
            <Tooltip
              label={previewing ? 'Close preview' : 'Preview in-line'}
              withinPortal
              position="left"
            >
              <ActionIcon
                variant="filled"
                color="dark"
                radius="xl"
                size="sm"
                aria-label={previewing ? 'Close preview' : 'Preview 3D model'}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setPreviewing((v) => !v);
                }}
              >
                <IconEye size={14} stroke={2} />
              </ActionIcon>
            </Tooltip>
          </Group>
        }
        footer={
          <Stack gap={6} className="w-full">
            <UserAvatarSimple
              id={user.id}
              username={user.username}
              profilePicture={user.profilePicture}
              deletedAt={user.deletedAt}
              cosmetics={user.cosmetics}
            />
            <Text
              size="xl"
              fw={700}
              lineClamp={3}
              lh={1.2}
              c="white"
              className={cardClasses.dropShadow}
            >
              {name}
            </Text>
            <Group gap={4} justify="space-between" wrap="nowrap">
              {hasStats && (
                <Badge
                  className={clsx(cardClasses.statChip, cardClasses.chip)}
                  variant="light"
                  radius="xl"
                >
                  <Group gap={4} wrap="nowrap">
                    {downloadCount > 0 && (
                      <Group gap={2} wrap="nowrap">
                        <IconDownload size={12} stroke={2.5} />
                        <Text size="xs">{abbreviateNumber(downloadCount)}</Text>
                      </Group>
                    )}
                    {commentCount > 0 && (
                      <Group gap={2} wrap="nowrap">
                        <IconMessageCircle2 size={12} stroke={2.5} />
                        <Text size="xs">{abbreviateNumber(commentCount)}</Text>
                      </Group>
                    )}
                    {reactionCount > 0 && (
                      <Group gap={2} wrap="nowrap">
                        <IconHeart size={12} stroke={2.5} fill="currentColor" color="#f87171" />
                        <Text size="xs">{abbreviateNumber(reactionCount)}</Text>
                      </Group>
                    )}
                  </Group>
                </Badge>
              )}
              {ratingCount > 0 && (
                <Badge
                  className={clsx(cardClasses.statChip, cardClasses.chip)}
                  variant="light"
                  radius="xl"
                >
                  <Group gap={2} wrap="nowrap">
                    <IconStar size={12} stroke={2} fill="currentColor" color="#facc15" />
                    <Text size="xs">
                      {ratingAvg.toFixed(1)}
                      <Text component="span" c="dimmed" ml={2}>
                        ({abbreviateNumber(ratingCount)})
                      </Text>
                    </Text>
                  </Group>
                </Badge>
              )}
            </Group>
          </Stack>
        }
        footerGradient
      />

      {/* Inline GLB preview overlay. Sits absolutely over the card's image and
          remains until the user closes it (or the user navigates away). The
          underlying card link still works — close the preview before clicking. */}
      {previewing && (
        <Box
          pos="absolute"
          inset={0}
          style={{
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--mantine-color-dark-9)',
            zIndex: 5,
          }}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {previewUrl ? (
            <Model3DViewer url={previewUrl} format={primaryFile?.format ?? 'glb'} />
          ) : (
            <Group justify="center" align="center" h="100%">
              <Text size="sm" c="dimmed">
                Loading preview…
              </Text>
            </Group>
          )}
        </Box>
      )}
    </Box>
  );
});
