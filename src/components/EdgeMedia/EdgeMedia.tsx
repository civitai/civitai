import { createStyles, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { CSSProperties, ReactNode, useRef } from 'react';
import { MediaType } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { useIsClient } from '~/providers/IsClientProvider';

export type EdgeMediaProps = EdgeUrlProps &
  Omit<JSX.IntrinsicElements['img'], 'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'metadata'> & {
    controls?: boolean;
    wrapperProps?: React.ComponentPropsWithoutRef<'div'>;
    contain?: boolean;
    fadeIn?: boolean;
  };

export function EdgeMedia({
  src,
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
  fadeIn = false,
  ...imgProps
}: EdgeMediaProps) {
  const { classes, cx } = useStyles({ maxWidth: width === 'original' ? undefined : width });
  const currentUser = useCurrentUser();

  const imgRef = useRef<HTMLImageElement>(null);
  if (fadeIn && imgRef.current?.complete) imgRef?.current?.style?.setProperty('opacity', '1');

  if (width && typeof width === 'number') width = Math.min(width, 4096);
  let transcode = false;
  const _name = name ?? imgProps.alt;
  const _inferredType =
    _name?.endsWith('.gif') || _name?.endsWith('.mp4') || _name?.endsWith('.webm')
      ? 'video'
      : 'image';

  let _type = type ?? _inferredType;

  // videos are always transcoded
  if (_inferredType === 'video' && _type === 'image') {
    transcode = true;
    anim = false;
  } else if (_type === 'video') {
    transcode = true;
    anim = anim ?? currentUser?.autoplayGifs ?? true;
  }

  // anim false makes a video url return the first frame as an image
  if (!anim) _type = 'image';

  const optimized = currentUser?.filePreferences?.imageFormat === 'optimized';

  const _src = getEdgeUrl(src, {
    width,
    fit,
    anim,
    transcode,
    blur,
    quality,
    gravity,
    optimized: optimized ? true : undefined,
    name,
    type: _type,
  });

  switch (_type) {
    case 'image':
      return (
        // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
        <img
          ref={imgRef}
          className={cx(classes.responsive, className, { [classes.fadeIn]: fadeIn })}
          onLoad={(e) => (e.currentTarget.style.opacity = '1')}
          src={_src}
          style={style}
          {...imgProps}
        />
      );
    case 'video':
      return (
        <EdgeVideo
          src={_src}
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
