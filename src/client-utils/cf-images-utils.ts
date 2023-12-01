import { MediaType } from '@prisma/client';
import { env } from '~/env/client.mjs';

// from options available in CF Flexible variants:
// https://developers.cloudflare.com/images/cloudflare-images/transform/flexible-variants/
export type EdgeUrlProps = {
  src: string;
  name?: string | null;
  width?: number | undefined | 'original';
  height?: number | undefined;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  anim?: boolean;
  blur?: number; // 0-250
  quality?: number; // 0-100
  gravity?: 'auto' | 'side' | 'left' | 'right' | 'top' | 'bottom';
  metadata?: 'keep' | 'copyright' | 'none';
  background?: string;
  gamma?: number;
  optimized?: boolean;
  transcode?: boolean;
  type?: MediaType;
};

const typeExtensions: Record<MediaType, string> = {
  image: '.jpeg',
  video: '.mp4',
  audio: '.mp3',
};

export function getEdgeUrl(
  src: string,
  { name, type, anim, transcode, width, ...variantParams }: Omit<EdgeUrlProps, 'src'>
) {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;
  const modifiedParams = {
    anim: anim ? undefined : anim,
    transcode: transcode ? true : undefined,
    width: width === 'original' ? undefined : width,
    original: width === 'original' ? true : undefined,
    ...variantParams,
  };
  const params = Object.entries(modifiedParams)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

  const extension = typeExtensions[type ?? MediaType.image];

  name = (name ?? src).replaceAll('%', ''); // % symbol is escape character for url encoding
  if (name.includes('.')) name = name.split('.').slice(0, -1).join('.') + extension;
  else name = name + extension;

  return [env.NEXT_PUBLIC_IMAGE_LOCATION, src, params.toString(), name].filter(Boolean).join('/');
}
