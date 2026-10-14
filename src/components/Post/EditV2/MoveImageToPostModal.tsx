import { Button, Loader, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function MoveImageToPostModal({
  fromPostId,
  imageId,
  onMoved,
}: {
  fromPostId: number;
  imageId: number;
  onMoved: (toPostId: number) => void;
}) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();
  const { data: targets, isLoading } = trpc.post.getImageMoveTargets.useQuery({ fromPostId });

  const moveMutation = trpc.post.moveImages.useMutation({
    onSuccess: async ({ postId }) => {
      onMoved(postId);
      await Promise.all([
        queryUtils.post.getEdit.invalidate({ id: postId }),
        queryUtils.post.getImageMoveTargets.invalidate(),
      ]);
      showSuccessNotification({
        title: 'Image moved',
        message: 'Its reactions, comments, tips and collection entries moved with it.',
      });
      dialog.onClose();
    },
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const move = (toPostId?: number) =>
    moveMutation.mutate({ imageIds: [imageId], fromPostId, toPostId });

  return (
    <Modal {...dialog} title="Move image to another post" centered>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Reactions, comments, tips, stickers and collection entries on this image stay with it.
          Only posts published on or before this one are listed, so moving never bumps the image up
          the feed.
        </Text>
        <Button
          variant="light"
          leftSection={<IconPlus size={16} />}
          onClick={() => move()}
          loading={moveMutation.isPending && !moveMutation.variables?.toPostId}
          disabled={moveMutation.isPending}
        >
          New post with this post&apos;s date
        </Button>
        {isLoading ? (
          <Loader className="mx-auto" size="sm" />
        ) : !targets?.length ? (
          <Text size="sm" c="dimmed" ta="center">
            No other posts this image can move into.
          </Text>
        ) : (
          <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
            {targets.map((target) => {
              const full = target.imageCount >= POST_IMAGE_LIMIT;
              return (
                <UnstyledButton
                  key={target.id}
                  className="flex items-center gap-3 rounded-md p-2 hover:bg-gray-1 disabled:opacity-50 dark:hover:bg-dark-5"
                  onClick={() => move(target.id)}
                  disabled={full || moveMutation.isPending}
                >
                  <div className="size-12 shrink-0 overflow-hidden rounded bg-gray-2 dark:bg-dark-6">
                    {target.coverUrl && (
                      <EdgeMedia
                        src={target.coverUrl}
                        width={96}
                        className="size-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Text size="sm" fw={500} lineClamp={1}>
                      {target.title || `Post #${target.id}`}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatDate(target.publishedAt)} · {target.imageCount}/{POST_IMAGE_LIMIT}{' '}
                      images
                    </Text>
                  </div>
                  {moveMutation.isPending && moveMutation.variables?.toPostId === target.id && (
                    <Loader size="xs" />
                  )}
                </UnstyledButton>
              );
            })}
          </div>
        )}
      </Stack>
    </Modal>
  );
}
