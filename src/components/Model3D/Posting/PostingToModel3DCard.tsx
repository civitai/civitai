import { Anchor, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconArrowRight, IconCube } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { trpc } from '~/utils/trpc';

type Props = {
  /** Render the chip directly for a known Model3D. Skips the postId lookup. */
  model3dId?: number | null;
  /** Resolve the chip from `Post.model3dId`. Used by the image viewers
   *  (they only know the postId; the link to the 3D model lives one hop away). */
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
  // Single round-trip per resolution path: when only postId is known, the
  // server resolves Post → Model3D in one query and returns the card payload
  // (or null). When the caller already has a model3dId, fall through to the
  // canonical getById. Visibility checks live in `getModel3DById` either way.
  const byPostQuery = trpc.model3d.getByPostId.useQuery(
    { postId: postId ?? 0 },
    { enabled: !model3dId && !!postId }
  );
  const byIdQuery = trpc.model3d.getById.useQuery(
    { id: model3dId ?? 0 },
    { enabled: !!model3dId }
  );

  const data = model3dId ? byIdQuery.data : byPostQuery.data;

  // Silent-skip while the server has yet to confirm a linked Model3D, OR once
  // it confirms there isn't one. Matches the silent-skip pattern of the
  // sibling "Posting to model" line. No skeleton — this is supporting
  // context, not a hero element.
  if (!data) return null;

  return (
    <Link legacyBehavior href={`/3d-models/${data.id}`} passHref>
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
