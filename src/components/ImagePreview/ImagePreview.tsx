import { ActionIcon, AspectRatio, Center, createStyles, Paper, PaperProps } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageModel } from '~/server/selectors/image.selector';
// import { useImageLightbox } from '~/hooks/useImageLightbox';
import { EdgeImage, EdgeImageProps } from '~/components/EdgeImage/EdgeImage';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { IconInfoCircle } from '@tabler/icons';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { getClampedSize } from '~/utils/blurhash';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  // lightboxImages?: ImageModel[];
  image: ImageModel;
  edgeImageProps?: Omit<EdgeImageProps, 'src'>;
  withMeta?: boolean;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
} & Omit<PaperProps, 'component'>;

export function ImagePreview({
  image: { url, name, width, height, hash, meta },
  edgeImageProps = {},
  nsfw,
  aspectRatio,
  withMeta,
  onClick,
  className,
  ...props
}: ImagePreviewProps) {
  const { classes, cx } = useStyles();

  if (!edgeImageProps.width && !edgeImageProps.height) {
    if (!edgeImageProps.height && width) edgeImageProps.width = width;
    else if (!edgeImageProps.width && height) edgeImageProps.height = height;
  }

  if (!width || !height) return null;
  const { width: cw, height: ch } = getClampedSize(
    width,
    height,
    edgeImageProps.height ?? edgeImageProps.width ?? 500,
    edgeImageProps.height ? 'height' : edgeImageProps.width ? 'width' : 'all'
  );

  const Preview = nsfw ? (
    <Center style={{ width: cw, height: ch, maxWidth: '100%' }}>
      <MediaHash hash={hash} width={width} height={height} />
    </Center>
  ) : (
    <div>
      <EdgeImage
        src={url}
        alt={name ?? undefined}
        {...edgeImageProps}
        onClick={onClick}
        style={onClick ? { cursor: 'pointer' } : undefined}
      />
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
    </div>
  );

  return (
    <Paper radius={0} className={cx(classes.root, className)} {...props}>
      {aspectRatio ? <AspectRatio ratio={aspectRatio}>{Preview}</AspectRatio> : Preview}
    </Paper>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    position: 'relative',
    overflow: 'hidden',
  },
}));
