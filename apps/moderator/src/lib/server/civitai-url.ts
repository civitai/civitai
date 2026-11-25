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

/** The main app's public origin: the redirect target for authenticated non-moderators, and the base
 *  for public links that must land on `.com`. Server calls to the main app use `civitaiInternalUrl`.
 *
 *  `.com`, NOT `.red`. Links a moderator follows are the other decision — see `civitaiLinkUrl`.
 *
 *  Defaulted here rather than at each call site: the fallback was written out six times, and two of
 *  those copies did not strip a trailing slash, so a value ending in `/` built `//api/...` from some
 *  callers and not others. */
export const civitaiAppUrl = (): string => trimSlash(env.CIVITAI_APP_URL || 'https://civitai.com');

/** Base for this server's calls to the main app's `/api/mod`, `/api/admin` and `/api/internal` routes:
 *  its in-cluster address. Outside production it falls back to `civitaiAppUrl()`. Production throws
 *  instead of falling back. */
export const civitaiInternalUrl = (): string => {
  if (env.CIVITAI_INTERNAL_URL) return trimSlash(env.CIVITAI_INTERNAL_URL);
  if (env.NODE_ENV === 'production')
    throw new Error('CIVITAI_INTERNAL_URL is not set, so calls to the main app are disabled.');
  return civitaiAppUrl();
};

/** `civitaiInternalUrl`, or null (logged) where that throws, for callers that report a failure instead. */
export const tryCivitaiInternalUrl = (): string | null => {
  try {
    return civitaiInternalUrl();
  } catch (e) {
    console.error('[civitai-url]', (e as Error).message);
    return null;
  }
};

/** The main app's WEBHOOK receiver. A different host from `civitaiAppUrl` — that is the web app, this
 *  is the ingress the orchestrator's training callbacks go to — so it cannot share that base. Here
 *  rather than inline in a page service, which is where a hostname goes to be un-findable when it moves. */
export const civitaiWebhookUrl = (): string =>
  trimSlash(env.CIVITAI_WEBHOOK_URL || 'https://api.civitai.com');
