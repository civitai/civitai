import { ActionIcon, Badge, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconArrowUpRight,
  IconBolt,
  IconDownload,
  IconEye,
  IconMessageCircle2,
  IconPhoto,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { memo, useState } from 'react';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import cardClasses from '~/components/Cards/Cards.module.css';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { Model3DActionsMenu } from '~/components/Model3D/Actions/Model3DActionsMenu';
import { Model3DThumbsUpButton } from '~/components/Model3D/ThumbsUp/Model3DThumbsUpButton';
import { NextLink as Link } from '~/components/NextLink/NextLink';
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
 * - The gold thumbs-up is the "recommend" toggle (Model3DReview), mirroring the
 *   AI-model thumbs-up; the count comes from `Model3DMetric.recommendedCount`.
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
  const {
    id,
    name,
    thumbnailImage,
    user,
    nsfwLevel,
    metric,
    status,
    nsfw,
    tosViolation,
    poi,
    minor,
    unlisted,
    lockedProperties,
    thumbnailImageId,
    userReview,
  } = data;

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
  const imageCount = metric?.imageCount ?? 0;
  const tippedAmountCount = metric?.tippedAmountCount ?? 0;
  const recommendedCount = metric?.recommendedCount ?? 0;
  // Optimistic tip overlay — matches ModelCard so a user's own tap updates the
  // displayed number immediately even though we don't invalidate the feed query.
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model3D', entityId: id });

  // The browsing-level shield + Blur-Mature-Content blur both key off the
  // image's `nsfwLevel`. `nullish-coalesce` with `?? ` would pin the value
  // at `0` when the thumbnail Image hasn't been scanned yet — which leaves
  // a freshly-rated Model3D rendered unblurred even though its own
  // `Model3D.nsfwLevel` is already set (and a viewer with `blurNsfw=true`
  // would expect the blur). `Math.max` picks the higher of the two so we
  // can't lose level information.
  const effectiveNsfwLevel = Math.max(thumbnailImage?.nsfwLevel ?? 0, nsfwLevel ?? 0);

  return (
    <Box pos="relative">
      <AspectRatioImageCard
        href={`/3d-models/${id}`}
        alt={name}
        contentType="model3d"
        contentId={id}
        aspectRatio="portrait"
        // Pin the corner browsing-level badge on for every viewer — matches
        // the rating chip users expect on Images / Models. The centered
        // "This image is rated X" overlay (rendered by ImageGuard2) still
        // owns the click-to-reveal toggle when the thumbnail is blurred.
        alwaysVisibleBadge
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
                nsfwLevel: effectiveNsfwLevel,
              }
            : undefined
        }
        header={({ safe }) => (
          // `safe` is ImageGuard2's `show` value (true = thumbnail revealed,
          // either because the content is SFW or because the user clicked
          // the centered Show overlay). We piggyback on it to gate the
          // Preview action — otherwise clicking Preview would mount the
          // 3D viewer over the blurred thumbnail and bypass the shield.
          // The Actions menu stays available (Report etc. don't expose
          // content). When the thumbnail is blurred we suppress the button
          // entirely; the centered "This image is rated X" overlay tells
          // the user to click Show first.
          <Group gap={4} justify="flex-end" wrap="nowrap" className="w-full">
            <Group gap={4} wrap="nowrap">
              {safe && (
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
              )}
              {/* Actions dropdown — owner/mod get full controls, any logged-in
                  user gets the Report action. Internally guards visibility, so
                  signed-out users see nothing rendered. */}
              <Model3DActionsMenu
                showReport
                triggerSize="sm"
                model3d={{
                  id,
                  userId: user.id,
                  status,
                  nsfw,
                  tosViolation,
                  poi,
                  minor,
                  unlisted,
                  nsfwLevel: nsfwLevel ?? 0,
                  lockedProperties: lockedProperties ?? [],
                  thumbnailImageId,
                }}
              />
            </Group>
          </Group>
        )}
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
              lh={1.35}
              c="white"
              className={cardClasses.dropShadow}
            >
              {name}
            </Text>
            <Group gap={4} justify="space-between" wrap="nowrap">
              <Badge
                className={clsx(cardClasses.statChip, cardClasses.chip)}
                classNames={{ label: 'flex flex-nowrap gap-2' }}
                variant="light"
                radius="xl"
              >
                {/* Stat chip mirrors ModelCardStats — icon size 14,
                    strokeWidth 2.5, bold lh-1 text — so the 3D feed reads
                    visually identical to the regular Model feed. Core metrics
                    render unconditionally (even at 0) so every card shows a
                    consistent stats row, matching the Model / Image feeds. */}
                <div className="flex items-center gap-0.5">
                  <IconDownload size={14} strokeWidth={2.5} />
                  <Text size="xs" lh={1} fw="bold">
                    {abbreviateNumber(downloadCount)}
                  </Text>
                </div>
                <div className="flex items-center gap-0.5">
                  <IconMessageCircle2 size={14} strokeWidth={2.5} />
                  <Text size="xs" lh={1} fw="bold">
                    {abbreviateNumber(commentCount)}
                  </Text>
                </div>
                {/* Images created with this 3D model (community Makes/Uses +
                    the creator's auto-post), sourced from Model3DMetric.imageCount. */}
                <div className="flex items-center gap-0.5">
                  <IconPhoto size={14} strokeWidth={2.5} />
                  <Text size="xs" lh={1} fw="bold">
                    {abbreviateNumber(imageCount)}
                  </Text>
                </div>
                {/* Buzz tip — surface the same Model-style interactive tip
                    button on the card. Server-side, `entityType: 'Model3D'`
                    is already on the allow-list in buzz.schema.ts and is
                    picked up by the Model3D metrics job, so a tap from here
                    flows all the way through to tippedAmountCount. */}
                <InteractiveTipBuzzButton
                  toUserId={user.id}
                  entityType="Model3D"
                  entityId={id}
                >
                  <div className="flex items-center gap-0.5">
                    <IconBolt size={14} strokeWidth={2.5} />
                    <Text size="xs" lh={1} fw="bold">
                      {abbreviateNumber(tippedAmountCount + tippedAmount)}
                    </Text>
                  </div>
                </InteractiveTipBuzzButton>
              </Badge>
              <Model3DThumbsUpButton
                model3dId={id}
                recommendedCount={recommendedCount}
                userReview={userReview ?? null}
              />
            </Group>
          </Stack>
        }
        footerGradient
      />

      {/* Inline GLB preview overlay. Sits absolutely over the card's image
          and captures pointer events so drag/orbit works in the viewer. The
          overlay would otherwise trap users (it covers the card link AND the
          header eye button), so we render two floating controls on top:
          a "close preview" X (toggles back to the thumbnail) and an
          "open model page" arrow (navigates into /3d-models/:id). */}
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
            // `size-full` matters for `compact`: the viewer's three.js
            // container uses `h-full` (vs. the default `min-h-[480px]`),
            // which only works when its Stack ancestor has a resolved
            // height. Without an explicit `className` here the Stack
            // collapses to content size (= 0 until the GLB resolves),
            // which is the "feed preview opens to a blank box" bug. The
            // wrapping Box's `inset={0}` already gives us a real pixel
            // height to chain off of. Variant picker is deliberately
            // omitted on the feed card — only the base mesh is loaded
            // via `primaryFile`, so there's no choice to expose.
            <Model3DViewer
              url={previewUrl}
              format={primaryFile?.format ?? 'glb'}
              compact
              className="size-full"
            />
          ) : (
            <Group justify="center" align="center" h="100%">
              <Text size="sm" c="dimmed">
                Loading preview…
              </Text>
            </Group>
          )}

          {/* Floating action bar — sits above the viewer canvas. */}
          <Group
            gap={4}
            pos="absolute"
            top={8}
            right={8}
            style={{ zIndex: 6, pointerEvents: 'auto' }}
            wrap="nowrap"
          >
            <Tooltip label="Open model page" withinPortal position="left">
              <ActionIcon
                component={Link}
                href={`/3d-models/${id}`}
                variant="filled"
                color="dark"
                radius="xl"
                size="sm"
                aria-label="Open 3D model page"
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                <IconArrowUpRight size={14} stroke={2} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Close preview" withinPortal position="left">
              <ActionIcon
                variant="filled"
                color="dark"
                radius="xl"
                size="sm"
                aria-label="Close preview"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setPreviewing(false);
                }}
              >
                <IconX size={14} stroke={2} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Box>
      )}
    </Box>
  );
});
