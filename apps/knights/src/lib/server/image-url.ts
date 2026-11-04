import { env } from '$env/dynamic/private';

const WIDTH = 800;

/** The image's page on the main site. */
export function imagePageUrl(imageId: number): string {
  const base = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/+$/, '');
  return `${base}/images/${imageId}`;
}

export const THUMBNAIL_WIDTH = 192;

/**
 * `optimized=true` is what the main site asks of every derived size: the CDN answers with a compressed variant (WebP, about a
 * quarter of the JPEG's bytes at the same width). `anim=false` keeps a GIF to one frame, as there.
 */
export function imageUrl(key: string, width = WIDTH): string {
  const base = env.IMAGE_LOCATION ?? '';
  return [base, key, `anim=false,width=${width},optimized=true`, `${key}.jpeg`]
    .filter(Boolean)
    .join('/');
}
