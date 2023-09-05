import { createStyles, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { CSSProperties, ReactNode } from 'react';
import { MediaType } from '@prisma/client';

export type EdgeMediaProps = EdgeUrlProps &
  Omit<JSX.IntrinsicElements['img'], 'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'metadata'> & {
    controls?: boolean;
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
  ...imgProps
}: EdgeMediaProps) {
  const { classes, cx } = useStyles({ maxWidth: width });
  const currentUser = useCurrentUser();

  if (width) width = Math.min(width, 4096);
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
        <img className={cx(classes.responsive, className)} src={_src} style={style} {...imgProps} />
      );
    case 'video':
      return (
        <EdgeVideo
          src={_src}
          className={cx(classes.responsive, className)}
          style={style}
          controls={controls}
        />
      );
    case 'audio':
    default:
      return <Text align="center">Unsupported media type</Text>;
  }
}

const useStyles = createStyles((_theme, params: { maxWidth?: number }) => ({
  responsive: { width: '100%', height: 'auto', maxWidth: params.maxWidth },
}));
