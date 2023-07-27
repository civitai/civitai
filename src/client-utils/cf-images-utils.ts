import { MediaType } from '@prisma/client';
import { env } from '~/env/client.mjs';
import { AUDIO_MIME_TYPE, IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/server/common/mime-types';

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
  type?: MediaType;
};

const typeExtensions: Record<MediaType, string> = {
  image: '.jpeg',
  video: '.webm',
  audio: '.mp3',
};

export function getEdgeUrl(
  src: string,
  { name, type, ...variantParams }: Omit<EdgeUrlProps, 'src'>
) {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;

  const params = Object.entries(variantParams)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

  const extension = typeExtensions[type ?? MediaType.image];

  name = name ?? src;
  if (name.includes('.')) name = name.split('.').slice(0, -1).join('.') + extension;
  else name = name + extension;

  return [env.NEXT_PUBLIC_IMAGE_LOCATION, src, params.toString(), name].filter(Boolean).join('/');
}

export function inferMediaType(mimeType: string) {
  if (IMAGE_MIME_TYPE.includes(mimeType as any)) return MediaType.image;
  if (VIDEO_MIME_TYPE.includes(mimeType as any)) return MediaType.video;
  if (AUDIO_MIME_TYPE.includes(mimeType as any)) return MediaType.audio;
  return undefined;
}
