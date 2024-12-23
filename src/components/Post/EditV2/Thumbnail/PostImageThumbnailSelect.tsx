import {
  ActionIcon,
  Button,
  Modal,
  SimpleGrid,
  Skeleton,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import produce from 'immer';
import { uniq } from 'lodash-es';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { SimpleImageUpload } from '~/libs/form/components/SimpleImageUpload';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { MIME_TYPES } from '~/server/common/mime-types';
import { SetVideoThumbnailInput } from '~/server/schema/image.schema';
import { MediaType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { roundDownToPowerOfTwo } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Props = {
  imageId: number;
  src: string;
  duration: number;
  width: number;
  postId?: number;
  thumbnailFrame?: number | null;
};

type ImageProps = {
  id?: number;
  nsfwLevel?: number;
  userId?: number;
  user?: { id: number };
  url: string;
  type: MediaType;
};

type State = {
  selectedFrame: number | null;
  customThumbnail: ImageProps | null;
};

const getSkipFrames = (duration: number) =>
  uniq([
    4,
    roundDownToPowerOfTwo(Math.floor(duration / 2)),
    roundDownToPowerOfTwo(Math.floor(duration)),
  ]);

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
  const [state, setState] = useState<State>({
    selectedFrame: thumbnailFrame ?? null,
    customThumbnail: null,
  });
  const { setThumbnail, loading } = useSetThumbnailMutation({ imageId, postId });

  const handleSubmit = async () => {
    try {
      await setThumbnail({
        frame: state.selectedFrame,
        customThumbnail: !state.selectedFrame ? state.customThumbnail : null,
      });
      dialog.onClose();
    } catch {} // Error is handled by mutation hook
  };

  return (
    <Modal title="Select Thumbnail" size="xl" {...dialog}>
      <div className="flex flex-col gap-8">
        <SimpleGrid
          spacing="md"
          breakpoints={[
            { minWidth: 'xs', cols: 1 },
            { minWidth: 'sm', cols: 2 },
          ]}
        >
          <SimpleImageUpload
            dropzoneProps={{
              className: 'flex h-full items-center justify-center',
              mt: 0,
              accept: [MIME_TYPES.png, MIME_TYPES.jpeg, MIME_TYPES.jpg],
            }}
            value={state.customThumbnail ?? undefined}
            aspectRatio={9 / 16}
            mt={-5} // Offset the dropzone margin
            onChange={(value) =>
              setState((current) => ({ ...current, customThumbnail: value, selectedFrame: null }))
            }
            withNsfwLevel={false}
          />
          {skipFrames.map((frame) => (
            <ThumbnailImageButton
              key={frame}
              frame={frame}
              src={src}
              width={width}
              selected={state.selectedFrame === frame}
              onClick={() =>
                setState((current) => ({
                  ...current,
                  selectedFrame: current.selectedFrame !== frame ? frame : null,
                }))
              }
            />
          ))}
        </SimpleGrid>
        <div className="flex w-full justify-end">
          <Button onClick={handleSubmit} loading={loading}>
            Submit
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ThumbnailImageButton({
  frame,
  width,
  src,
  selected,
  onClick,
}: {
  frame: number;
  width: number;
  src: string;
  selected: boolean;
  onClick: VoidFunction;
}) {
  const [status, setStatus] = useState<'loading' | 'error' | 'loaded'>('loading');

  return (
    <div
      className={clsx(
        'h-[210px] flex-1 rounded-lg',
        selected && 'border-[3px] border-solid border-blue-5',
        status === 'error' && 'hidden'
      )}
    >
      <Skeleton
        className={clsx('h-[210px] w-full', status !== 'loading' && 'hidden')}
        width="100%"
        visible={status === 'loading'}
        animate
      />
      <UnstyledButton className="size-full" onClick={onClick}>
        <EdgeMedia2
          src={src}
          className={clsx('h-full rounded-[4px] object-cover', status !== 'loaded' && 'hidden')}
          type="image"
          anim={false}
          skip={frame}
          width={width ?? DEFAULT_EDGE_IMAGE_WIDTH}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          transcode
          fadeIn
        />
      </UnstyledButton>
    </div>
  );
}

export function CurrentThumbnail({
  src,
  thumbnailFrame,
  thumbnailUrl,
  width,
  imageId,
  postId,
}: CurrentThumbnailProps) {
  const { setThumbnail, loading } = useSetThumbnailMutation({ imageId, postId });
  const hasThumbnailUrl = !!thumbnailUrl;

  if (!thumbnailFrame && !hasThumbnailUrl) return <Text>Thumbnail will be auto generated.</Text>;
  const finalSrc = thumbnailUrl ?? src;

  return (
    <div className="flex w-full items-start justify-between gap-2">
      <div className="size-24 shrink-0 grow-0 overflow-hidden rounded-lg">
        <EdgeMedia2
          // TODO: remove key and rework video cover logic
          key={finalSrc}
          src={finalSrc}
          type="image"
          className="h-full object-cover object-top"
          width={width ?? DEFAULT_EDGE_IMAGE_WIDTH}
          skip={!hasThumbnailUrl ? thumbnailFrame ?? undefined : undefined}
          anim={false}
          transcode
        />
      </div>

      <ActionIcon
        color="red"
        onClick={() => setThumbnail({ frame: null, customThumbnail: null }).catch(() => null)}
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
  thumbnailUrl?: string | null;
  postId?: number;
};

const useSetThumbnailMutation = ({ postId, imageId }: { imageId: number; postId?: number }) => {
  const queryUtils = trpc.useUtils();

  const setThumbnailMutation = trpc.image.setThumbnail.useMutation({
    onSuccess: (_, payload) => {
      if (postId) {
        const { frame, customThumbnail } = payload;
        queryUtils.post.getEdit.setData(
          { id: postId },
          produce((old) => {
            if (!old) return;

            const affectedImage = old.images.find((image) => image.id === imageId);
            if (affectedImage) {
              if (frame) {
                affectedImage.metadata = { ...affectedImage.metadata, thumbnailFrame: frame };
                affectedImage.thumbnailUrl = null;
              } else {
                affectedImage.metadata = { ...affectedImage.metadata, thumbnailFrame: null };
              }

              if (customThumbnail) affectedImage.thumbnailUrl = customThumbnail.url;
              else affectedImage.thumbnailUrl = null;
            }
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

  const handleSetThumbnail = ({
    frame,
    customThumbnail,
  }: Omit<SetVideoThumbnailInput, 'imageId'>) => {
    return setThumbnailMutation.mutateAsync({ imageId, frame, customThumbnail, postId });
  };

  return { setThumbnail: handleSetThumbnail, loading: setThumbnailMutation.isLoading };
};
