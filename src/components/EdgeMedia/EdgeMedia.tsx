import { createStyles } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

export type EdgeMediaProps = EdgeUrlProps &
  Omit<JSX.IntrinsicElements['img'], 'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'metadata'>;

export function EdgeMedia({
  src,
  width,
  height,
  fit,
  anim,
  blur,
  quality,
  gravity,
  className,
  name,
  mimeType,
  ...imgProps
}: EdgeMediaProps) {
  const { classes, cx } = useStyles({ maxWidth: width });
  const currentUser = useCurrentUser();

  if (width) width = Math.min(width, 4096);
  if (height) height = Math.min(height, 4096);
  mimeType ??=
    imgProps.alt?.endsWith('.gif') ||
    imgProps.alt?.endsWith('.mp4') ||
    imgProps.alt?.endsWith('.webm')
      ? 'video/webm'
      : 'image/jpeg';
  const isVideo = mimeType.startsWith('video/');
  anim ??= isVideo && currentUser ? (!currentUser.autoplayGifs ? false : undefined) : undefined;
  if (anim && !isVideo) anim = undefined;
  const transcode = isVideo && anim !== false ? true : undefined;
  const optimized = currentUser?.filePreferences?.imageFormat === 'optimized';

  const _src = getEdgeUrl(src, {
    width,
    height,
    fit,
    anim,
    transcode,
    blur,
    quality,
    gravity,
    optimized: optimized ? true : undefined,
    mimeType,
    name,
  });

  if (isVideo && anim !== false)
    return (
      <video className={cx(classes.responsive, className)} autoPlay loop muted playsInline>
        <source src={_src} type="video/webm" />
      </video>
    );

  // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
  return <img className={cx(classes.responsive, className)} src={_src} {...imgProps} />;
}

const useStyles = createStyles((_theme, params: { maxWidth?: number }) => ({
  responsive: { width: '100%', height: 'auto', maxWidth: params.maxWidth },
}));
