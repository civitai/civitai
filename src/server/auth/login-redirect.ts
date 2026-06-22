// Builds the redirect from /login to the centralized hub (auth.civitai.com). Pure (no request access) so it's
// unit-testable; the caller resolves `origin` from the request host. Thin wrapper over the shared
// `buildHubLoginUrl` (src/utils/hub-login.ts) — the single source the popup path (auth-helpers.ts) also uses.

import { buildHubLoginUrl } from '~/utils/hub-login';

export function buildHubLoginRedirect(opts: {
  origin: string; // the request's OWN origin (e.g. https://civitai.red) — land the user back here, not a fixed primary
  hubIssuer: string; // AUTH_JWT_ISSUER, e.g. https://auth.civitai.com
  dest: string; // post-login destination (safeReturn)
  reason?: string;
  error?: string;
  selectAccount?: boolean;
}): string {
  return buildHubLoginUrl({
    origin: opts.origin,
    hub: opts.hubIssuer,
    dest: opts.dest,
    reason: opts.reason,
    error: opts.error,
    selectAccount: opts.selectAccount,
  });
}
