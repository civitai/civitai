import { createStyles, MantineNumberSize } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { CSSProperties } from 'react';
import { EdgeMedia2, EdgeMediaProps } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGetInfinite } from '~/types/router';
import clsx from 'clsx';

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
  className?: string;
  style?: CSSProperties;
};

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
  ...props
}: ImagePreviewProps) {
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

  return (
    <div
      className={clsx('relative overflow-hidden rounded-md', className)}
      style={{ ...style, aspectRatio }}
      {...props}
    >
      {nsfw ? (
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
      )}
    </div>
  );
}
