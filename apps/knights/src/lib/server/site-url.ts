import { env } from '$env/dynamic/private';

/**
 * Where links a player follows go (image pages, profiles, "Back to Civitai"). Knights shows only on civitai.red, and
 * civitai.com answers an R+ image with an "available on .red" page, so this is not `CIVITAI_APP_URL` (server-to-server calls).
 */
export function civitaiSiteUrl(): string {
  return (env.CIVITAI_SITE_URL || 'https://civitai.red').replace(/\/+$/, '');
}
