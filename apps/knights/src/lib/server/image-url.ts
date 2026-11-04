import { env } from '$env/dynamic/private';

const WIDTH = 800;

/** The image's page on the main site. */
export function imagePageUrl(imageId: number): string {
  const base = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/+$/, '');
  return `${base}/images/${imageId}`;
}

export const THUMBNAIL_WIDTH = 192;

/**
 * `quality` makes the CDN re-encode a JPEG at the asked width for every original (measured 72–108 KB at 800px). Measured
 * alternatives misbehave: `optimized=true` or `anim=false` return a PNG original as a ~1 MB PNG, and a bare `width` can
 * return an older image's cached 2048px variant.
 */
export function imageUrl(key: string, width = WIDTH): string {
  const base = env.IMAGE_LOCATION ?? '';
  return [base, key, `width=${width},quality=80`, `${key}.jpeg`]
    .filter(Boolean)
    .join('/');
}
