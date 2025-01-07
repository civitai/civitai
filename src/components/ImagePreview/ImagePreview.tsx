import { AspectRatio, Box, BoxProps, createStyles, MantineNumberSize } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { CSSProperties } from 'react';
import { EdgeMedia2, EdgeMediaProps } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGetInfinite } from '~/types/router';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  // lightboxImages?: ImageModel[];
  image: Pick<
    ImageGetInfinite[number],
    'id' | 'url' | 'name' | 'width' | 'height' | 'hash' | 'type'
  > & { metadata?: MixedObject | null };
  edgeImageProps?: Omit<EdgeMediaProps, 'src'>;
  withMeta?: boolean;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  radius?: MantineNumberSize;
  cropFocus?: 'top' | 'bottom' | 'left' | 'right' | 'center';
} & Omit<BoxProps, 'component'>;

export function ImagePreview({
  image: { id, url, name, type, width, height, hash, metadata },
  edgeImageProps = {},
  nsfw,
  aspectRatio,
  withMeta,
  style,
  onClick,
  className,
  radius = 0,
  cropFocus,
  ...props
}: ImagePreviewProps) {
  const { classes, cx } = useStyles({ radius });

  aspectRatio ??= Math.max((width ?? 16) / (height ?? 9), 9 / 16);
  edgeImageProps.width ??= width ?? undefined;

  if (!edgeImageProps.width && !edgeImageProps.height) {
    if (!edgeImageProps.height && width) edgeImageProps.width = width;
    else if (!edgeImageProps.width && height) edgeImageProps.height = height;
  }

  if (!width || !height) return null;

  const edgeImageStyle: CSSProperties = {
    ...edgeImageProps.style,
    maxHeight: '100%',
    maxWidth: '100%',
  };
  if (style?.height || style?.maxHeight) edgeImageStyle.maxHeight = '100%';
  const Image = nsfw ? (
    <MediaHash hash={hash} width={width} height={height} />
  ) : (
    <EdgeMedia2
      src={url}
      name={name ?? id.toString()}
      alt={name ?? undefined}
      type={type}
      {...edgeImageProps}
      onClick={onClick}
      metadata={metadata}
      style={edgeImageStyle}
    />
  );

  return (
    <Box className={cx(classes.root, className)} style={{ ...style }} {...props}>
      {aspectRatio === 0 ? (
        Image
      ) : (
        <AspectRatio
          ratio={aspectRatio}
          sx={{
            color: 'white',
            ['& > img, & > video']: {
              objectPosition: cropFocus ?? 'center',
            },
          }}
        >
          {Image}
        </AspectRatio>
      )}
    </Box>
  );
}

const useStyles = createStyles((theme, { radius }: { radius?: MantineNumberSize }) => ({
  root: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: theme.fn.radius(radius),
  },
}));
