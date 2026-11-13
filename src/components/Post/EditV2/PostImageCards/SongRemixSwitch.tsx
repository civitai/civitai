import { Switch } from '@mantine/core';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { withMetadata } from '~/components/Post/EditV2/PostImageCards/SongDetails';
import type { PostEditImageDetail } from '~/server/services/post.service';
import { songAllowsRemix } from '~/shared/form-graph/generation/audio/song-metadata';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Whether others may use a song's recipe in the generator. */
export function SongRemixSwitch({ image }: { image: PostEditImageDetail }) {
  const updateImage = usePostEditStore((state) => state.updateImage);
  const { mutate, isPending } = trpc.post.updateImage.useMutation({
    onSuccess: (_, { id, allowRemix }) =>
      updateImage(id, (image) => {
        image.metadata = withMetadata(image.metadata, { allowRemix });
      }),
    onError: (error) =>
      showErrorNotification({ title: 'Failed to update song', error: new Error(error.message) }),
  });

  return (
    <Switch
      size="sm"
      labelPosition="left"
      label="Allow remixes"
      description="Others can use this song's recipe in the generator."
      checked={songAllowsRemix(image.metadata)}
      disabled={isPending}
      onChange={(e) => mutate({ id: image.id, allowRemix: e.currentTarget.checked })}
      classNames={{
        body: 'justify-between gap-3',
        labelWrapper: 'flex-1',
        label: 'text-[13px] font-semibold text-black dark:text-white p-0',
        description: 'text-xs mt-0.5',
      }}
    />
  );
}
