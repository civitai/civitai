import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconCube, IconExternalLink } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { getModel3DUrl } from '~/utils/string-helpers';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Thumbnail-driven mod affordance (workstream H continuation, plan §2.10).
 *
 * Renders a small inline "this image is the thumbnail of a 3D Model" badge +
 * link to the Model3D detail page and a one-click "Also unpublish parent
 * Model3D" button when a Model3D is linked to the given image.
 *
 * Backed by `trpc.model3d.getByThumbnailImageId` which is moderator-only —
 * non-mods will get a 401 from the lookup and the component will render null.
 * Renders nothing when no Model3D is linked.
 */
export function Model3DModAction({ imageId }: { imageId: number }) {
  const queryUtils = trpc.useUtils();
  const { data: model3d, isLoading } = trpc.model3d.getByThumbnailImageId.useQuery(
    { imageId },
    {
      // Mod-only endpoint — silently no-op for non-mods.
      retry: false,
      // The lookup is cheap and stable; cache for the session.
      staleTime: 60 * 1000,
    }
  );

  const unpublishMutation = trpc.model3d.unpublish.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Parent 3D Model unpublished' });
      // Refresh the lookup so the status badge updates inline.
      await queryUtils.model3d.getByThumbnailImageId.invalidate({ imageId });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to unpublish 3D Model',
        error: new Error(error.message),
      });
    },
  });

  if (isLoading || !model3d) return null;

  const alreadyUnpublished = model3d.status !== Model3DStatus.Published;

  return (
    <Stack gap={4} p="xs" style={{ cursor: 'auto', color: 'initial' }}>
      <Group gap={6} wrap="nowrap">
        <Badge color="violet" leftSection={<IconCube size={12} />} size="sm">
          3D Model
        </Badge>
        <Text size="xs" c="dimmed" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
          Thumbnail of{' '}
          <Link
            href={getModel3DUrl({ id: model3d.id, name: model3d.name })}
            target="_blank"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
          >
            {model3d.name}
            <IconExternalLink size={10} />
          </Link>
        </Text>
        <Badge size="xs" color={alreadyUnpublished ? 'gray' : 'green'}>
          {model3d.status}
        </Badge>
      </Group>
      <PopConfirm
        message={`Also unpublish parent 3D Model "${model3d.name}"?`}
        position="bottom-end"
        onConfirm={() => unpublishMutation.mutate({ id: model3d.id })}
        withArrow
        withinPortal
      >
        <Button
          size="xs"
          variant="light"
          color="red"
          fullWidth
          loading={unpublishMutation.isPending}
          disabled={alreadyUnpublished}
        >
          {alreadyUnpublished ? 'Parent already unpublished' : 'Also unpublish parent Model3D'}
        </Button>
      </PopConfirm>
    </Stack>
  );
}
