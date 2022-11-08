import { AspectRatio, Box, BoxProps, Paper, PaperProps } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreviewModel } from '~/server/validators/image/selectors';
import Image from 'next/image';

//TODO - proper image preview component with nsfw hash built in
type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
} & ImagePreviewModel &
  Omit<PaperProps, 'component'>;

export function ImagePreview({
  url,
  name,
  hash,
  width,
  height,
  nsfw,
  aspectRatio,
  ...props
}: ImagePreviewProps) {
  return (
    <Paper style={{ overflow: 'hidden', ...props.style }} {...props}>
      <AspectRatio ratio={aspectRatio ?? (width ?? 16) / (height ?? 9)}>
        {nsfw ? (
          <MediaHash hash={hash} width={width} height={height} />
        ) : (
          <Image
            src={url}
            alt={name ?? undefined}
            objectFit="cover"
            objectPosition="top"
            layout="fill"
          />
        )}
      </AspectRatio>
    </Paper>
  );
}
