import { MediaType } from '@prisma/client';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';

// from options available in CF Flexible variants:
// https://developers.cloudflare.com/images/cloudflare-images/transform/flexible-variants/
export type EdgeUrlProps = {
  src: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
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
  original?: true;
};

const typeExtensions: Record<MediaType, string> = {
  image: '.jpeg',
  video: '.mp4',
  audio: '.mp3',
};

export function getEdgeUrl(
  src: string,
  {
    name,
    type,
    anim,
    transcode,
    width,
    height,
    original,
    fit,
    blur,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
  }: Omit<EdgeUrlProps, 'src'>
) {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;

  if (!width && !height) original = true;
  if (original) {
    width = undefined;
    height = undefined;
  }
  // if(width && height) // TODO
  if (width && width > 1800) width = 1800;
  if (height && height > 1000) height = 1000;

  const modifiedParams = {
    anim: anim ? undefined : anim,
    transcode: transcode ? true : undefined,
    width: width ?? undefined,
    height: height ?? undefined,
    original,
    fit,
    blur,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
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

const videoTypeExtensions = ['.gif', '.mp4', '.webm'];
export function useEdgeUrl(src: string, options: Omit<EdgeUrlProps, 'src'> | undefined) {
  const currentUser = useCurrentUser();
  if (!src || src.startsWith('http') || src.startsWith('blob'))
    return { url: src, type: options?.type };

  let { anim, transcode } = options ?? {};
  const inferredType = videoTypeExtensions.some((ext) => options?.name?.endsWith(ext))
    ? 'video'
    : 'image';
  let type = options?.type ?? inferredType;

  if (inferredType === 'video' && type === 'image') {
    transcode = true;
    anim = false;
  } else if (type === 'video') {
    transcode = true;
    anim = anim ?? currentUser?.autoplayGifs ?? true;
  }

  if (!anim) type = 'image';

  const optimized = currentUser?.filePreferences?.imageFormat === 'optimized';

  return {
    url: getEdgeUrl(src, {
      ...options,
      anim,
      transcode,
      type,
      optimized: optimized ? true : undefined,
    }),
    type,
  };
}
