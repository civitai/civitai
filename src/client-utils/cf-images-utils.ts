import { env } from '~/env/client.mjs';

// from options available in CF Flexible variants:
// https://developers.cloudflare.com/images/cloudflare-images/transform/flexible-variants/
type MimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/gif'
  | 'image/mp4'
  | 'image/webm';
export type EdgeUrlProps = {
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
  optimized?: boolean;
  transcode?: boolean;
  mimeType?: string;
};

const mimeTypeExtensions: Record<MimeType, string> = {
  'image/jpeg': '.jpeg',
  'image/png': '.jpeg',
  'image/webp': '.jpeg',
  'image/gif': '.jpeg',
  'image/mp4': '.webm',
  'image/webm': '.webm',
};

export function getEdgeUrl(src: string, { name, ...variantParams }: Omit<EdgeUrlProps, 'src'>) {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;

  const params = Object.entries(variantParams)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

  const extension =
    variantParams.anim === false
      ? '.jpeg'
      : mimeTypeExtensions[(variantParams.mimeType ?? 'image/jpeg') as MimeType];

  name = name ?? src;
  if (name.includes('.')) name = name.split('.').slice(0, -1).join('.') + extension;
  else name = name + extension;

  return [env.NEXT_PUBLIC_IMAGE_LOCATION, src, params.toString(), name].filter(Boolean).join('/');
}
