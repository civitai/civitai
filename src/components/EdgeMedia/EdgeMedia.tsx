import { Text } from '@mantine/core';
import type { MediaType } from '~/shared/utils/prisma/enums';
import React, { SyntheticEvent, useEffect, useRef } from 'react';
import type { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { getInferredMediaType } from '~/client-utils/cf-images-utils';
import { shouldAnimateByDefault } from '~/components/EdgeMedia/EdgeMedia.util';
import type { EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import clsx from 'clsx';
import styles from './EdgeMedia.module.scss';
import { useUserSettings } from '~/providers/UserSettingsProvider';

export type EdgeMediaProps = EdgeUrlProps &
  Omit<JSX.IntrinsicElements['img'], 'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'metadata'> & {
    controls?: boolean;
    wrapperProps?: React.ComponentPropsWithoutRef<'div'>;
    contain?: boolean;
    fadeIn?: boolean;
    mediaRef?: [HTMLImageElement | null, (ref: HTMLImageElement | null) => void];
    muted?: boolean;
    html5Controls?: boolean;
    onMutedChange?: (muted: boolean) => void;
    videoRef?: React.ForwardedRef<EdgeVideoRef>;
    metadata?: ImageMetadata | VideoMetadata | null;
    youtubeVideoId?: string;
    vimeoVideoId?: string;
    thumbnailUrl?: string | null;
    disableWebm?: boolean;
    disablePoster?: boolean;
    videoProps?: React.HTMLAttributes<HTMLVideoElement> &
      React.MediaHTMLAttributes<HTMLVideoElement>;
    imageProps?: React.HTMLAttributes<HTMLImageElement>;
  };

export function EdgeMedia({
  src,
  height,
  width,
  fit,
  anim,
  blur,
  quality,
  gravity,
  className,
  name,
  type,
  style,
  children,
  controls,
  wrapperProps,
  contain,
  fadeIn,
  mediaRef,
  transcode,
  original,
  skip,
  muted,
  html5Controls,
  onMutedChange,
  videoRef,
  youtubeVideoId,
  vimeoVideoId,
  thumbnailUrl,
  disableWebm,
  disablePoster,
  videoProps,
  imageProps,
  optimized,
  ...imgProps
}: EdgeMediaProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  if (fadeIn && imgRef.current?.complete) imgRef?.current?.style?.setProperty('opacity', '1');
  useEffect(() => {
    mediaRef?.[1](imgRef.current);
  }, [mediaRef]);

  if (width && typeof width === 'number') width = Math.min(width, 4096);

  const inferredType = getInferredMediaType(src, { name, type });

  const options = {
    name,
    width,
    height,
    fit,
    blur,
    quality,
    gravity,
    transcode,
    type,
    original,
    skip,
    anim,
    optimized,
  };

  switch (inferredType) {
    case 'image': {
      return (
        <EdgeImage
          ref={imgRef}
          src={src}
          options={options}
          className={className}
          style={style}
          {...imgProps}
          {...imageProps}
        />
      );
    }
    case 'video':
      return (
        <EdgeVideo
          src={src}
          thumbnailUrl={thumbnailUrl}
          options={options}
          style={{
            ...style,
            ['--max-width' as string]: width ? `${width}px` : undefined,
          }}
          className={clsx(styles.responsive, className, { [styles.fadeIn]: fadeIn })}
          controls={controls}
          wrapperProps={wrapperProps}
          contain={contain}
          fadeIn={fadeIn}
          muted={muted}
          html5Controls={html5Controls}
          onMutedChange={onMutedChange}
          ref={videoRef}
          youtubeVideoId={youtubeVideoId}
          vimeoVideoId={vimeoVideoId}
          disableWebm={disableWebm}
          disablePoster={disablePoster}
          {...videoProps}
        />
      );
    default:
      return <Text align="center">Unsupported media type</Text>;
  }
}

export function EdgeMedia2({
  metadata,
  ...props
}: Omit<EdgeMediaProps, 'type' | 'metadata'> & {
  metadata?: MixedObject | null;
  type: MediaType;
}) {
  const autoplayGifs = useUserSettings((x) => x.autoplayGifs);
  const anim =
    props.anim ??
    shouldAnimateByDefault({ type: props.type, metadata, forceDisabled: !autoplayGifs });

  return <EdgeMedia {...props} anim={anim} />;
}
