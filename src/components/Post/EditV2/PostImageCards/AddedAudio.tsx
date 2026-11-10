import { Button, Text } from '@mantine/core';
import { IconMusic, IconTrash } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useDeletePostImage } from '~/components/Post/EditV2/PostImageCards/useDeletePostImage';
import { audioMetadataSchema } from '~/server/schema/media.schema';
import type { PostEditImageDetail } from '~/server/services/post.service';

/**
 * A song in the post editor: the player and its title, none of the image controls (resources,
 * tools, techniques, ratings, prompt). The cover-led music card replaces it.
 */
export function AddedAudio({ image }: { image: PostEditImageDetail }) {
  const { onDelete, isDeleting } = useDeletePostImage(image.id);
  const title = audioMetadataSchema.safeParse(image.metadata).data?.title;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-1 bg-gray-0 p-3 dark:border-dark-6 dark:bg-dark-8">
      <div className="flex items-center gap-3">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-gray-2 dark:bg-dark-6">
          <IconMusic size={28} />
        </div>
        <Text fw={600} className="min-w-0 flex-1 truncate">
          {title || 'Untitled song'}
        </Text>
        <Button
          color="red"
          variant="subtle"
          size="compact-sm"
          leftSection={<IconTrash size={16} />}
          loading={isDeleting}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
      <EdgeMedia src={image.url} type="audio" className="w-full" />
    </div>
  );
}
