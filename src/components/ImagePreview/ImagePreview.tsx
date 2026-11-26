import type { MantineSpacing } from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { CSSProperties } from 'react';
import type { EdgeMediaProps } from '~/components/EdgeMedia/EdgeMedia';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import type { ImageGetInfinite } from '~/types/router';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { RetractedMedia } from '~/components/RetractedMedia/RetractedMedia';
import { useRetractedMedia } from '~/components/RetractedMedia/retracted-media';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  // lightboxImages?: ImageModel[];
  image: Pick<
    ImageGetInfinite[number],
    'id' | 'url' | 'name' | 'width' | 'height' | 'hash' | 'type'
  > & {
    metadata?: MixedObject | null;
    /** With it, a moderator's tile the CDN refuses is loaded from `/api/mod/retracted-media`. */
    ingestion?: ImageGetInfinite[number]['ingestion'] | null;
  };
  edgeImageProps?: Omit<EdgeMediaProps, 'src'>;
  withMeta?: boolean;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  radius?: MantineSpacing;
  cropFocus?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  className?: string;
  style?: CSSProperties;
};

export function ImagePreview({
  image,
  edgeImageProps = {},
  nsfw,
  aspectRatio,
  withMeta,
  style,
  onClick,
  className,
  radius,
  ...props
}: ImagePreviewProps) {
  const { id, url, name, type, width, height, hash, metadata } = image;
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const {
    src: retractedSrc,
    onCdnError,
    mediaRef,
  } = useRetractedMedia(image, features.modRetractedMedia ? currentUser : null);
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
    objectFit: 'cover',
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
      ) : retractedSrc ? (
        <RetractedMedia
          src={retractedSrc}
          type={type}
          alt={name ?? undefined}
          className="size-full object-cover"
        />
      ) : (
        <EdgeMedia2
          src={url}
          name={name ?? id.toString()}
          alt={name ?? undefined}
          type={type}
          imageId={id}
          {...edgeImageProps}
          onClick={onClick}
          metadata={metadata}
          style={edgeImageStyle}
          onError={onCdnError}
          mediaRef={mediaRef}
          videoProps={onCdnError ? { onError: onCdnError } : undefined}
        />
      )}
    </div>
  );
}
