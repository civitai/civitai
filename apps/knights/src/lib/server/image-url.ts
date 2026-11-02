import { env } from '$env/dynamic/private';

const WIDTH = 800;

export const THUMBNAIL_WIDTH = 192;

export function imageUrl(key: string, width = WIDTH): string {
  const base = env.IMAGE_LOCATION ?? '';
  return [base, key, `width=${width}`, `${key}.jpeg`].filter(Boolean).join('/');
}
