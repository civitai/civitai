import { AspectRatio, Paper, PaperProps } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreviewModel } from '~/server/validators/image/selectors';
import Image from 'next/image';
import { useImageLightbox } from '~/hooks/useImageLightbox';

//TODO - proper image preview component with nsfw hash built in
type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  lightboxImages?: ImagePreviewModel[];
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
  lightboxImages = [],
  style,
  ...props
}: ImagePreviewProps) {
  const { openImageLightbox } = useImageLightbox();

  const includeLightbox = !!lightboxImages.length;
  const handleClick = () => {
    const index = lightboxImages.findIndex((image) => image.url === url);
    openImageLightbox({ initialSlide: index, images: lightboxImages });
  };

  return (
    <Paper style={{ overflow: 'hidden', ...style }} {...props}>
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
            onClick={includeLightbox ? handleClick : undefined}
            style={includeLightbox ? { cursor: 'pointer' } : undefined}
          />
        )}
      </AspectRatio>
    </Paper>
  );
}
