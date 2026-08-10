import { env } from '$env/dynamic/private';

/** Base for every content link a moderator follows. `.red` renders every browsing level and holds
 *  content `.com` will not serve, so a `.com` link can dead-end on exactly the item being moderated
 *  (ClickUp 868kn8aa0). Distinct from `CIVITAI_APP_URL`, which is a server-to-server API base and a
 *  redirect target for non-moderators — pointing those at `.red` is a different decision. */
export const civitaiLinkUrl = (): string =>
  (env.CIVITAI_LINK_URL || env.CIVITAI_APP_URL || 'https://civitai.red').replace(/\/$/, '');
