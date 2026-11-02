import { env } from '$env/dynamic/private';

const WIDTH = 800;

/** The image's page on the main site. */
export function imagePageUrl(imageId: number): string {
  const base = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/+$/, '');
  return `${base}/images/${imageId}`;
}

export const THUMBNAIL_WIDTH = 192;

export function imageUrl(key: string, width = WIDTH): string {
  const base = env.IMAGE_LOCATION ?? '';
  return [base, key, `width=${width}`, `${key}.jpeg`].filter(Boolean).join('/');
}
