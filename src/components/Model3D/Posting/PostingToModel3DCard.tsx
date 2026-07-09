import { Anchor, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconArrowRight, IconCube } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getModel3DUrl } from '~/utils/string-helpers';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { trpc } from '~/utils/trpc';

type Props = {
  /**
   * Linked Model3D id, threaded from the caller's already-fetched payload.
   * Three states, intentionally distinct:
   *  - `number`    → render the chip directly via `getById` (no postId lookup).
   *  - `null`      → the caller's payload RESOLVED that there's no visible
   *                  Model3D for this post (e.g. the `image.get` data-gate).
   *                  Render nothing AND do NOT fall back to `getByPostId` —
   *                  this is the durable elimination of the ambient call.
   *  - `undefined` → the caller has no signal (e.g. a feed-sourced item that
   *                  isn't enriched). Fall back to the `getByPostId` lookup.
   */
  model3dId?: number | null;
  /** Resolve the chip from `Post.model3dId`. Used by the image viewers
   *  (they only know the postId; the link to the 3D model lives one hop away).
   *  Only consulted when `model3dId` is `undefined` (no payload signal). */
  postId?: number | null;
  /** Label eyebrow. Defaults to "Posting to 3D Model" (matches the post-create
   *  context). Use "Posted to 3D Model" on read-only surfaces. */
  label?: string;
  className?: string;
};

/**
 * Compact "Posted/Posting to 3D Model" chip linking back to the Model3D
 * detail page. Renders the Variant-2 design (thumbnail + eyebrow + truncating
 * name + arrow). When neither prop resolves to a Model3D the component
 * renders nothing — safe to drop in any post-or-image context.
 */
export function PostingToModel3DCard({
  model3dId,
  postId,
  label = 'Posting to 3D Model',
  className,
}: Props) {
  // `undefined` means the caller had no payload signal → use the postId
  // lookup. `null` means the caller's payload already resolved "no visible
  // Model3D" → render nothing and DON'T fall back (the durable data-gate; this
  // is what keeps `getByPostId` from firing on the image-detail viewers). A
  // number → render directly via getById.
  const hasResolvedSignal = model3dId !== undefined;

  // Single round-trip per resolution path: when only postId is known (no
  // resolved signal), the server resolves Post → Model3D in one query and
  // returns the card payload (or null). When the caller already has a
  // model3dId, fall through to the canonical getById. Visibility checks live
  // in `getModel3DById` / the server-side data-gate either way.
  const byPostQuery = trpc.model3d.getByPostId.useQuery(
    { postId: postId ?? 0 },
    { enabled: !hasResolvedSignal && !!postId }
  );
  const byIdQuery = trpc.model3d.getById.useQuery(
    { id: model3dId ?? 0 },
    { enabled: !!model3dId }
  );

  const data = model3dId
    ? byIdQuery.data
    : hasResolvedSignal
    ? null // resolved-absent: don't read the (disabled) postId query
    : byPostQuery.data;

  // Silent-skip while the server has yet to confirm a linked Model3D, OR once
  // it confirms there isn't one. Matches the silent-skip pattern of the
  // sibling "Posting to model" line. No skeleton — this is supporting
  // context, not a hero element.
  if (!data) return null;

  return (
    <Link legacyBehavior href={getModel3DUrl({ id: data.id, name: data.name })} passHref>
      <Anchor
        underline="never"
        className={`group block rounded-md border border-blue-6/30 bg-blue-6/10 p-3 transition-colors hover:bg-blue-6/15 ${
          className ?? ''
        }`}
      >
        <Group gap="sm" wrap="nowrap">
          <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-dark-6/40 dark:bg-dark-8/60">
            {data.thumbnailImage?.url ? (
              <EdgeMedia
                src={data.thumbnailImage.url}
                width={88}
                alt={data.name ?? '3D model thumbnail'}
                className="size-full object-cover"
              />
            ) : (
              <IconCube size={22} className="text-blue-5" />
            )}
          </div>
          <Stack gap={2} className="min-w-0 flex-1">
            <Text size="10px" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.3 }}>
              {label}
            </Text>
            <Text size="sm" fw={500} lineClamp={1} className="break-all">
              {data.name}
            </Text>
          </Stack>
          <ThemeIcon
            size={28}
            radius="sm"
            variant="light"
            color="blue"
            className="shrink-0 transition-transform group-hover:translate-x-0.5"
          >
            <IconArrowRight size={16} />
          </ThemeIcon>
        </Group>
      </Anchor>
    </Link>
  );
}
