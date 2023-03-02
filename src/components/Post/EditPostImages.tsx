import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { trpc } from '~/utils/trpc';
import { useEditPostContext, ImageUpload } from '~/components/Post/EditPostProvider';
import { Stack } from '@mantine/core';
import { PostImage } from '~/server/selectors/post.selector';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Fragment } from 'react';

export default function EditPostImages() {
  const id = useEditPostContext((state) => state.id);
  const upload = useEditPostContext((state) => state.upload);
  const images = useEditPostContext((state) => state.images);

  const handleDrop = async (files: File[]) => upload(id, files);

  return (
    <Stack>
      <ImageDropzone onDrop={handleDrop} count={images.length} />
      <Stack>
        {images.map(({ type, data }, index) => (
          <Fragment key={index}>
            {type === 'image' ? <ImageController {...data} /> : <ImageUpload {...data} />}
          </Fragment>
        ))}
      </Stack>
    </Stack>
  );
}

function ImageController({
  id,
  url,
  name,
  nsfw,
  width,
  height,
  hash,
  meta,
  generationProcess,
  needsReview,
  _count,
}: PostImage) {
  return (
    <div style={{ position: 'relative' }}>
      <EdgeImage
        src={url}
        alt={name ?? undefined}
        // width={500}
      />
    </div>
  );
}

function ImageUpload({ url, name, uuid }: ImageUpload) {
  return (
    <div style={{ position: 'relative' }}>
      <EdgeImage
        src={url}
        alt={name ?? undefined}
        // width={500}
      />
    </div>
  );
}
