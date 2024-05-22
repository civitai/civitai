import { createStyles, Text } from '@mantine/core';
import React, { useEffect, useRef } from 'react';
import { EdgeUrlProps, useEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';

export type EdgeMediaProps = EdgeUrlProps &
  Omit<JSX.IntrinsicElements['img'], 'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'metadata'> & {
    controls?: boolean;
    wrapperProps?: React.ComponentPropsWithoutRef<'div'>;
    contain?: boolean;
    fadeIn?: boolean;
    mediaRef?: [HTMLImageElement | null, (ref: HTMLImageElement | null) => void];
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
  });

  switch (inferredType) {
    case 'image':
      return (
        // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
        <img
          ref={imgRef}
          className={cx(classes.responsive, className, { [classes.fadeIn]: fadeIn })}
          onLoad={(e) => (e.currentTarget.style.opacity = '1')}
          onError={(e) => e.currentTarget.classList.add('load-error')}
          src={url}
          style={style}
          {...imgProps}
        />
      );
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
        />
      );
    case 'audio':
    default:
      return <Text align="center">Unsupported media type</Text>;
  }
}

const useStyles = createStyles((theme, params: { maxWidth?: number }) => ({
  responsive: {
    width: '100%',
    height: 'auto',
    maxWidth: params.maxWidth,
  },
  fadeIn: {
    opacity: 0,
    transition: theme.other.fadeIn,
  },
}));
