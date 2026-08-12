import { env } from '$env/dynamic/private';

/** Base for every content link a moderator follows. `.red` renders every browsing level and holds
 *  content `.com` will not serve, so a `.com` link can dead-end on exactly the item being moderated
 *  (ClickUp 868kn8aa0). Distinct from `CIVITAI_APP_URL`, which is a server-to-server API base and a
 *  redirect target for non-moderators — pointing those at `.red` is a different decision.
 *
 *  It used to fall back to `CIVITAI_APP_URL` as a convenience for local setups, which quietly made that
 *  different decision for us: `CIVITAI_APP_URL` is set to `.com` wherever this actually runs, so the
 *  fallback fired everywhere and every link shipped `.com` — the exact dead end above. A host that wants
 *  a different base now has to say so. */
export const civitaiLinkUrl = (): string =>
  (env.CIVITAI_LINK_URL || 'https://civitai.red').replace(/\/$/, '');
