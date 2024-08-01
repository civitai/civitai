import { createStyles, Text } from '@mantine/core';
import { MediaType } from '@prisma/client';
import { IconPlayerPlayFilled } from '@tabler/icons-react';
import React, { useEffect, useRef } from 'react';
import { EdgeUrlProps, useEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeVideo, EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { MAX_ANIMATION_DURATION_SECONDS } from '~/server/common/constants';
import { VideoMetadata, videoMetadataSchema } from '~/server/schema/media.schema';

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
  ...imgProps
}: EdgeMediaProps) {
  const { classes, cx } = useStyles({ maxWidth: width ?? undefined });
  // const currentUser = useCurrentUser();

  const imgRef = useRef<HTMLImageElement>(null);
  if (fadeIn && imgRef.current?.complete) imgRef?.current?.style?.setProperty('opacity', '1');
  useEffect(() => {
    mediaRef?.[1](imgRef.current);
  }, [mediaRef]);

  if (width && typeof width === 'number') width = Math.min(width, 4096);
  const { url, type: inferredType } = useEdgeUrl(src, {
    width,
    height,
    fit,
    anim,
    transcode,
    blur,
    quality,
    gravity,
    name,
    type,
    original,
    skip,
  });

  switch (inferredType) {
    case 'image': {
      const img = (
        // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
        <img
          ref={imgRef}
          className={cx(classes.responsive, className, { [classes.fadeIn]: fadeIn })}
          onLoad={(e) => (fadeIn ? (e.currentTarget.style.opacity = '1') : undefined)}
          onError={(e) => e.currentTarget.classList.add('load-error')}
          src={url}
          style={style}
          {...imgProps}
        />
      );
      if (type === 'video') {
        return (
          <div className={classes.videoThumbRoot}>
            <IconPlayerPlayFilled className={classes.playButton} />
            {img}
          </div>
        );
      } else {
        return img;
      }
    }
    case 'video':
      return (
        <EdgeVideo
          src={url}
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
        />
      );
    case 'audio':
    default:
      return <Text align="center">Unsupported media type</Text>;
  }
}

const useStyles = createStyles((theme, params: { maxWidth?: number }, getRef) => {
  const ref = getRef('playButton');
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
      position: 'relative',
      '&:hover': {
        [`& .${ref}`]: {
          backgroundColor: 'rgba(0,0,0,0.8)',
        },
      },
      img: {
        objectFit: 'cover',
        height: '100%',
        objectPosition: '50% 50%',
      },
    },
    playButton: {
      ref,
      width: 80,
      height: 80,
      color: theme.white,
      backgroundColor: 'rgba(0,0,0,.6)',
      padding: 20,
      borderRadius: '50%',
      boxShadow: `0 2px 2px 1px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.2)`,
      transition: 'background-color 200ms ease',
      position: 'absolute',
      top: '50%',
      left: '50%',
      zIndex: 2,
      transform: 'translate(-50%, -50%)',
    },
  };
});
