import { createStyles } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

export type EdgeImageProps = EdgeUrlProps &
  Omit<JSX.IntrinsicElements['img'], 'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'metadata'>;

export function EdgeImage({
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
  ...imgProps
}: EdgeImageProps) {
  const { classes, cx } = useStyles({ maxWidth: width });
  const currentUser = useCurrentUser();

  if (width) width = Math.min(width, 4096);
  if (height) height = Math.min(height, 4096);
  const isGif = imgProps.alt?.endsWith('.gif');
  anim ??= isGif && currentUser ? (!currentUser.autoplayGifs ? false : undefined) : undefined;
  const gamma = anim === false ? 0.99 : undefined;
  if (anim && !isGif) anim = undefined;
  const optimized = currentUser?.filePreferences?.imageFormat === 'optimized';

  const _src = getEdgeUrl(src, {
    width,
    height,
    fit,
    anim,
    blur,
    quality,
    gravity,
    optimized: optimized ? true : undefined,
    gamma,
    name,
  });

  // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
  return <img className={cx(classes.responsive, className)} src={_src} {...imgProps} />;
}

const useStyles = createStyles((_theme, params: { maxWidth?: number }) => ({
  responsive: { width: '100%', height: 'auto', maxWidth: params.maxWidth },
}));
