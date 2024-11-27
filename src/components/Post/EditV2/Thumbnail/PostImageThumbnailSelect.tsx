import { ActionIcon, Button, Modal, UnstyledButton } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import produce from 'immer';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = {
  imageId: number;
  src: string;
  duration: number;
  width: number;
  postId?: number;
  thumbnailFrame?: number | null;
};

const getSkipFrames = (duration: number) => [4, Math.floor(duration / 2), Math.floor(duration)];

export function PostImageThumbnailSelect({
  src,
  duration,
  width,
  imageId,
  postId,
  thumbnailFrame,
}: Props) {
  const skipFrames = getSkipFrames(duration);

  const dialog = useDialogContext();
  const [selectedFrame, setSelectedFrame] = useState(thumbnailFrame);
  const { setThumbnail, loading } = useSetThumbnailMutation({ imageId, postId });

  const handleSubmit = async () => {
    try {
      await setThumbnail({ frame: selectedFrame ?? null });
      dialog.onClose();
    } catch {} // Error is handled by mutation hook
  };

  return (
    <Modal title="Select Thumbnail" size="lg" {...dialog}>
      <div className="flex flex-col gap-8">
        <div className="flex gap-4">
          {skipFrames.map((frame) => (
            <UnstyledButton
              key={frame}
              className={clsx(
                'rounded-lg',
                selectedFrame === frame && 'border-[3px] border-solid border-blue-5'
              )}
              style={{
                width: `calc(100%/${skipFrames.length || 1} - 16px)`,
              }}
              onClick={() => setSelectedFrame((current) => (current !== frame ? frame : null))}
            >
              <EdgeMedia
                src={src}
                className="rounded-[4px]"
                type="image"
                anim={false}
                skip={frame}
                width={width ?? DEFAULT_EDGE_IMAGE_WIDTH}
                transcode
              />
            </UnstyledButton>
          ))}
        </div>
        <div className="flex w-full justify-end">
          <Button onClick={handleSubmit} loading={loading}>
            Submit
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CurrentThumbnail({
  src,
  thumbnailFrame,
  width,
  imageId,
  postId,
}: CurrentThumbnailProps) {
  const { setThumbnail, loading } = useSetThumbnailMutation({ imageId, postId });

  return (
    <div className="flex w-full items-start justify-between gap-2">
      <div className="size-24 shrink-0 grow-0 overflow-hidden rounded-lg">
        <EdgeMedia
          src={src}
          type="image"
          className="h-full object-cover object-top"
          width={width ?? DEFAULT_EDGE_IMAGE_WIDTH}
          skip={thumbnailFrame ?? undefined}
          anim={false}
          transcode
        />
      </div>

      <ActionIcon
        color="red"
        onClick={() => setThumbnail({ frame: null }).catch(() => null)}
        loading={loading}
      >
        <IconTrash size={16} />
      </ActionIcon>
    </div>
  );
}

type CurrentThumbnailProps = {
  src: string;
  imageId: number;
  width: number;
  thumbnailFrame?: number | null;
  postId?: number;
};

const useSetThumbnailMutation = ({ postId, imageId }: { imageId: number; postId?: number }) => {
  const queryUtils = trpc.useUtils();

  const setThumbnailMutation = trpc.image.setThumbnail.useMutation({
    onSuccess: (_, payload) => {
      if (postId) {
        const { frame } = payload;
        queryUtils.post.getEdit.setData(
          { id: postId },
          produce((old) => {
            if (!old) return;
            const affectedImage = old.images.find((image) => image.id === imageId);
            if (affectedImage && 'duration' in affectedImage.metadata)
              affectedImage.metadata.thumbnailFrame = frame;
          })
        );
      }
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to set thumbnail',
        error: new Error(error.message),
      });
    },
  });

  const handleSetThumbnail = ({ frame }: { frame: number | null }) => {
    return setThumbnailMutation.mutateAsync({ imageId, frame });
  };

  return { setThumbnail: handleSetThumbnail, loading: setThumbnailMutation.isLoading };
};
