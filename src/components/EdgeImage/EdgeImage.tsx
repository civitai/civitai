import { createStyles } from '@mantine/core';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';

// from options available in CF Flexible variants:
// https://developers.cloudflare.com/images/cloudflare-images/transform/flexible-variants/
export type EdgeImageProps = Omit<
  JSX.IntrinsicElements['img'],
  'src' | 'srcSet' | 'ref' | 'width' | 'height' | 'loading'
> & {
  src: string;
  name?: string | null;
  width?: number | undefined;
  height?: number | undefined;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  anim?: boolean;
  blur?: number; // 0-250
  quality?: number; // 0-100
  gravity?: 'auto' | 'side' | 'left' | 'right' | 'top' | 'bottom';
  metadata?: 'keep' | 'copyright' | 'none';
  background?: string;
  gamma?: number;
};

export function getEdgeUrl(src: string, { name, ...variantParams }: Omit<EdgeImageProps, 'src'>) {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;

  const params = Object.entries(variantParams)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

  return [env.NEXT_PUBLIC_IMAGE_LOCATION, src, params.toString(), name ?? src].join('/');
}

export function EdgeImage({
  src,
  width,
  height,
  fit,
  anim,
  blur,
  quality,
  gravity,
  metadata,
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

  src = getEdgeUrl(src, {
    width,
    height,
    fit,
    anim,
    blur,
    quality,
    gravity,
    metadata,
    gamma,
    name,
  });
  // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
  return <img className={cx(classes.responsive, className)} src={src} {...imgProps} />;
}

const useStyles = createStyles((_theme, params: { maxWidth?: number }) => ({
  responsive: { width: '100%', height: 'auto', maxWidth: params.maxWidth },
}));
