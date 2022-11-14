import { AspectRatio, Paper, PaperProps } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageModel } from '~/server/validators/image/selectors';
import { useImageLightbox } from '~/hooks/useImageLightbox';
import { EdgeImage, EdgeImageProps } from '~/components/EdgeImage/EdgeImage';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  lightboxImages?: ImageModel[];
  image: ImageModel;
  edgeImageProps?: Omit<EdgeImageProps, 'src'>;
} & Omit<PaperProps, 'component'>;

export function ImagePreview({
  image: { url, name, width, height, hash },
  edgeImageProps = {},
  nsfw,
  aspectRatio,
  lightboxImages = [],
  style,
  ...props
}: ImagePreviewProps) {
  const { openImageLightbox } = useImageLightbox();

  if (!edgeImageProps.width && width) edgeImageProps.width = width;
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
          <EdgeImage
            src={url}
            alt={name ?? undefined}
            {...edgeImageProps}
            onClick={includeLightbox ? handleClick : undefined}
            style={includeLightbox ? { cursor: 'pointer' } : undefined}
          />
        )}
      </AspectRatio>
    </Paper>
  );
}
