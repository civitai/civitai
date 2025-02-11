import { createStyles, Text } from '@mantine/core';
import { MediaType } from '~/shared/utils/prisma/enums';
import React, { useEffect, useRef } from 'react';
import { EdgeUrlProps, getInferredMediaType } from '~/client-utils/cf-images-utils';
import { shouldAnimateByDefault } from '~/components/EdgeMedia/EdgeMedia.util';
import { EdgeVideo, EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';

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
  ...imgProps
}: EdgeMediaProps) {
  const { classes, cx } = useStyles({ maxWidth: width ?? undefined });

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
        />
      );
    }
    case 'video':
      return (
        <EdgeVideo
          src={src}
          thumbnailUrl={thumbnailUrl}
          options={options}
          className={cx(classes.responsive, className, { [classes.fadeIn]: fadeIn })}
          style={style}
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
  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);
  const anim =
    props.anim ??
    shouldAnimateByDefault({ type: props.type, metadata, forceDisabled: !autoplayGifs });

  return <EdgeMedia {...props} anim={anim} />;
}

const useStyles = createStyles((theme, params: { maxWidth?: number }, getRef) => {
  return {
    responsive: {
      width: '100%',
      height: 'auto',
      maxWidth: params.maxWidth,
    },
    fadeIn: {
      opacity: 0,
      transition: theme.other.fadeIn,
    },
    videoThumbRoot: {
      height: '100%',
      width: '100%',
      position: 'relative',

      img: {
        objectFit: 'cover',
        height: '100%',
        objectPosition: '50% 50%',
      },
    },
  };
});
