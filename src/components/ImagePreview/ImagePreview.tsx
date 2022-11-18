import { ActionIcon, AspectRatio, Paper, PaperProps } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageModel } from '~/server/selectors/image.selector';
import { useImageLightbox } from '~/hooks/useImageLightbox';
import { EdgeImage, EdgeImageProps } from '~/components/EdgeImage/EdgeImage';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { IconInfoCircle } from '@tabler/icons';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  lightboxImages?: ImageModel[];
  image: ImageModel;
  edgeImageProps?: Omit<EdgeImageProps, 'src'>;
  withMeta?: boolean;
} & Omit<PaperProps, 'component'>;

export function ImagePreview({
  image: { url, name, width, height, hash, meta },
  edgeImageProps = {},
  nsfw,
  aspectRatio,
  lightboxImages = [],
  style,
  withMeta,
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
    <Paper radius={0} style={{ overflow: 'hidden', position: 'relative', ...style }} {...props}>
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
      {!nsfw && withMeta && meta && (
        <ImageMetaPopover meta={meta as ImageMetaProps}>
          <ActionIcon
            variant="transparent"
            style={{ position: 'absolute', bottom: '5px', right: '5px' }}
            size="lg"
          >
            <IconInfoCircle color="white" />
          </ActionIcon>
        </ImageMetaPopover>
      )}
    </Paper>
  );
}
