import { env } from '$env/dynamic/private';

/**
 * The main app's origin for server-to-server calls (`CIVITAI_APP_URL`, else civitai.com), without a trailing slash. Not
 * `civitaiSiteUrl()` (`site-url.ts`), which is where links players follow go.
 */
export function mainAppBase(): string {
  const base = env.CIVITAI_APP_URL || 'https://civitai.com';
  return base.endsWith('/') ? base.slice(0, -1) : base;
}
