import { env } from '$env/dynamic/public';

// Port of the main app's `getEdgeUrl` (src/client-utils/cf-images-utils.ts), trimmed of React +
// per-user file-preference logic. Given a Cloudflare-images key (the Image row's `url`/GUID column —
// NOT the numeric `id`) it builds a CDN delivery URL with flexible-variant transform params.
//
// Base origin comes from PUBLIC_IMAGE_LOCATION (e.g. https://image.civitai.com/<accountHash>).

export type MediaType = 'image' | 'video' | 'audio';

export type EdgeUrlOptions = {
  name?: string | null;
  width?: number | null;
  height?: number | null;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  anim?: boolean;
  quality?: number; // 0-100
  gravity?: 'auto' | 'side' | 'left' | 'right' | 'top' | 'bottom';
  metadata?: 'keep' | 'copyright' | 'none';
  background?: string;
  gamma?: number;
  optimized?: boolean;
  transcode?: boolean;
  type?: MediaType;
  original?: boolean;
  skip?: number;
};

const typeExtensions: Record<MediaType, string> = {
  image: '.jpeg',
  video: '.mp4',
  audio: '.mp3',
};

// Discrete width ladder mirroring civitai-image-cacher's CommonSizes. Snapping client-side to the
// same ladder collapses cache cardinality before the request is emitted.
export const COMMON_IMAGE_WIDTHS = [96, 320, 450, 512, 800, 1200, 1600, 2200] as const;

export function snapWidthToCommonSize(width: number): number {
  for (const size of COMMON_IMAGE_WIDTHS) {
    if (size === width) return width;
    if (size > width) return size;
  }
  return width;
}

const videoTypeExtensions = ['.gif', '.mp4', '.webm'];

export function getInferredMediaType(
  src: string,
  options?: { name?: string | null; type?: MediaType }
): MediaType {
  return (
    options?.type ??
    (videoTypeExtensions.some((ext) => (options?.name || src)?.endsWith(ext)) ? 'video' : 'image')
  );
}

export function getEdgeUrl(src: string, options: EdgeUrlOptions = {}): string {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;

  let {
    name,
    type,
    anim,
    transcode,
    width,
    height,
    original,
    fit,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
    skip,
  } = options;

  if (!width && !height && original === undefined) original = true;
  if (original) {
    width = undefined;
    height = undefined;
  }
  if (width) width = snapWidthToCommonSize(width);
  if (width && width > 1800) width = 1800;
  if (height && height > 1000) height = 1000;

  const modifiedParams = {
    anim: anim ? undefined : anim,
    transcode: transcode ? true : undefined,
    width: width ?? undefined,
    height: height ?? undefined,
    original,
    fit,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
    skip,
  };
  const params = Object.entries(modifiedParams)
    .map(([key, value]) => (value !== undefined ? `${key}=${value}` : undefined))
    .filter((x): x is string => x !== undefined)
    .join(',');

  const extension = typeExtensions[type ?? 'image'];

  name = (name ?? src ?? '').replaceAll('%', ''); // % is the url-encoding escape char
  if (name.includes('.')) name = name.split('.').slice(0, -1).join('.') + extension;
  else name = name + extension;

  const base = env.PUBLIC_IMAGE_LOCATION ?? '';
  return [base, src, params, name].filter(Boolean).join('/');
}

/**
 * Resolve playback + poster URLs for a video key, mirroring the main app's EdgeVideoBase:
 * the playback URL transcodes+animates; the poster is a still first frame.
 */
export function getVideoUrls(
  src: string,
  options: EdgeUrlOptions = {},
  thumbnailUrl?: string | null
): { mp4: string; webm: string; poster: string } {
  const mp4 = getEdgeUrl(src, { ...options, type: 'video', anim: true, transcode: true });
  const poster = getEdgeUrl(thumbnailUrl ?? src, {
    ...options,
    type: 'image',
    anim: false,
    original: false,
  });
  return { mp4, webm: mp4.replace('.mp4', '.webm'), poster };
}
