import { env } from '$env/dynamic/private';
import { civitaiSiteUrl } from './site-url';

const WIDTH = 1200;

/** The image's page on the main site. */
export function imagePageUrl(imageId: number): string {
  return `${civitaiSiteUrl()}/images/${imageId}`;
}

export const THUMBNAIL_WIDTH = 192;

/**
 * Widths come from the CDN's common-size ladder (`COMMON_IMAGE_WIDTHS` in the main app). `optimized=true` should yield a
 * compressed variant; as of 2026-11-04 the CDN instead serves PNG originals unchanged (~1 MB), an upstream bug.
 */
export function imageUrl(key: string, width = WIDTH): string {
  const base = env.IMAGE_LOCATION ?? '';
  return [base, key, `width=${width},optimized=true`, `${key}.jpeg`].filter(Boolean).join('/');
}
