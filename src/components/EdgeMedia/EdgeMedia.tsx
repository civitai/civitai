import { createStyles, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

export type EdgeMediaProps = EdgeUrlProps &
  Omit<JSX.IntrinsicElements['img'], 'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'metadata'>;

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
  ...imgProps
}: EdgeMediaProps) {
  const { classes, cx } = useStyles({ maxWidth: width });
  const currentUser = useCurrentUser();

  if (width) width = Math.min(width, 4096);
  type ??=
    imgProps.alt?.endsWith('.gif') ||
    imgProps.alt?.endsWith('.mp4') ||
    imgProps.alt?.endsWith('.webm')
      ? 'video'
      : 'image';

  anim = type === 'video' ? anim ?? currentUser?.autoplayGifs ?? true : undefined;
  type = !anim ? 'image' : type;

  // #region [temporary code while backend updates to support transcoding better]
  if (imgProps.alt?.endsWith('.gif') || name?.endsWith('.gif')) {
    type = 'image';
  }
  // #endregion

  const transcode = type === 'video'; // transcode relies on the initial type
  const optimized = currentUser?.filePreferences?.imageFormat === 'optimized';

  // TODO.Briant make sure that setting type to image for something that

  // videos are always transcoded
  // anim false makes a video url return the first frame as an image

  const _src = getEdgeUrl(src, {
    width,
    fit,
    anim: anim,
    transcode,
    blur,
    quality,
    gravity,
    optimized: optimized ? true : undefined,
    name,
    type: type,
  });

  switch (type) {
    case 'image':
      return (
        // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
        <img className={cx(classes.responsive, className)} src={_src} style={style} {...imgProps} />
      );
    case 'video':
      return (
        <video
          className={cx(classes.responsive, className)}
          autoPlay={anim ?? true}
          loop
          muted
          playsInline
          style={style}
        >
          <source src={_src} type="video/webm" />
        </video>
      );
    case 'audio':
    default:
      return <Text align="center">Unsupported media type</Text>;
  }
}

const useStyles = createStyles((_theme, params: { maxWidth?: number }) => ({
  responsive: { width: '100%', height: 'auto', maxWidth: params.maxWidth },
}));
