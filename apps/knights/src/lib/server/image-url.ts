import { env } from '$env/dynamic/private';

const WIDTH = 800;

export function imageUrl(key: string): string {
  const base = env.IMAGE_LOCATION ?? '';
  return [base, key, `width=${WIDTH}`, `${key}.jpeg`].filter(Boolean).join('/');
}
