import { env } from '$env/dynamic/private';

const trimSlash = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value);

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
  trimSlash(env.CIVITAI_LINK_URL || 'https://civitai.red');

/** Base for server-to-server calls to the main app — `/api/mod/*`, the Meilisearch callback, the
 *  new-order finalize — and the redirect target for authenticated non-moderators.
 *
 *  `.com`, NOT `.red`: this is an API base, and the session cookie these calls relay is issued for
 *  `.civitai.com`. Links a moderator follows are the other decision — see `civitaiLinkUrl`.
 *
 *  Defaulted here rather than at each call site: the fallback was written out six times, and two of
 *  those copies did not strip a trailing slash, so a value ending in `/` built `//api/...` from some
 *  callers and not others. */
export const civitaiAppUrl = (): string => trimSlash(env.CIVITAI_APP_URL || 'https://civitai.com');

/** The main app's WEBHOOK receiver. A different host from `civitaiAppUrl` — that is the web app, this
 *  is the ingress the orchestrator's training callbacks go to — so it cannot share that base. Here
 *  rather than inline in a page service, which is where a hostname goes to be un-findable when it moves. */
export const civitaiWebhookUrl = (): string =>
  trimSlash(env.CIVITAI_WEBHOOK_URL || 'https://api.civitai.com');
