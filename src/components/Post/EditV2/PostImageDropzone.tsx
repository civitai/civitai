import { Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { z } from 'zod';
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
import { usePostImagesContext } from '~/components/Post/EditV2/PostImagesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { MediaUploadOnCompleteProps, useMediaUpload } from '~/hooks/useMediaUpload';
import { POST_IMAGE_LIMIT, constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { PostDetailEditable } from '~/server/services/post.service';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { trpc } from '~/utils/trpc';

const max = POST_IMAGE_LIMIT;
const querySchema = z.object({
  src: z.coerce.string().optional(),
});

type ControlledImage = Partial<PostDetailEditable['images'][number]> & MediaUploadOnCompleteProps;

export function PostImageDropzone() {
  const { postId, modelVersionId, images, setImages } = usePostImagesContext((state) => state);
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { src } = querySchema.parse(router.query);

  const { mutate } = trpc.post.addImage.useMutation({
    onSuccess: (data) =>
      setImages((images) => [...images, { status: 'added', ...data } as ControlledImage]),
  });

  const { files, canAdd, error, upload } = useMediaUpload({
    count: images.length,
    max,
    maxSize: [{ type: 'image', maxSize: constants.mediaUpload.maxImageFileSize }],
    onComplete: (props) => {
      const index = Math.max(...images.map((x) => x.index)) + 1;
      switch (props.status) {
        case 'added':
          return mutate({ ...props, postId, modelVersionId: modelVersionId ?? undefined, index });
        case 'blocked':
          return setImages((images) => [...images, { ...props, index }]);
      }
    },
  });

  const handleDrop = (files: File[]) => {
    if (!currentUser?.muted) upload(files);
  };

  useEffect(() => {
    async function handleSrc() {
      if (!src) return;
      const files = await orchestratorMediaTransmitter.getFiles(src);
      if (files.length) handleDrop([...files]);
    }
    handleSrc();
  }, []); // eslint-disable-line

  return (
    <div className={`flex flex-col gap-3`}>
      <div className="w-full">
        <MediaDropzone
          onDrop={handleDrop}
          accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
          disabled={!canAdd}
          error={error}
          max={max}
        />
      </div>
      <div className="flex flex-col">
        {files.map((tracked) => (
          <div key={tracked.url} className="flex justify-between align-center">
            <Text lineClamp={1}>{tracked.file.name}</Text>
            <Text>{Math.floor(tracked.progress)}%</Text>
          </div>
        ))}
      </div>
    </div>
  );
}
