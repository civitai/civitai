// Builds the redirect from /login to the centralized hub (auth.civitai.com). Pure (no request access) so it's
// unit-testable; the caller resolves `origin` from the request host. Mirrors the popup path's hubLoginEntryUrl.

const registrable = (host: string) => host.toLowerCase().split('.').slice(-2).join('.');

export function buildHubLoginRedirect(opts: {
  origin: string; // the request's OWN origin (e.g. https://civitai.red) — land the user back here, not a fixed primary
  hubIssuer: string; // AUTH_JWT_ISSUER, e.g. https://auth.civitai.com
  dest: string; // post-login destination (safeReturn)
  reason?: string;
  error?: string;
  selectAccount?: boolean;
}): string {
  const { origin, hubIssuer, dest, reason, error, selectAccount } = opts;
  const crossSite = registrable(new URL(origin).host) !== registrable(new URL(hubIssuer).host);

  // post-login runs the side-effects the hub can't (ref_* cookies + tracking/referral) then forwards to dest. When
  // the request origin is cross-site to the hub, wrap it in /api/auth/sync so this domain mints its own cookie
  // before post-login runs. `reason` rides the post-login URL for attribution.
  const reasonQuery = reason ? `&reason=${encodeURIComponent(reason)}` : '';
  const postLoginPath = `/api/auth/post-login?dest=${encodeURIComponent(dest)}${reasonQuery}`;
  const landing = crossSite
    ? `${origin}/api/auth/sync?returnUrl=${encodeURIComponent(postLoginPath)}`
    : `${origin}${postLoginPath}`;

  const hubLogin = new URL('/login', hubIssuer);
  hubLogin.searchParams.set('returnUrl', landing);
  if (reason) hubLogin.searchParams.set('reason', reason); // hub analytics
  if (error) hubLogin.searchParams.set('error', error); // shown on the hub login page
  if (selectAccount) hubLogin.searchParams.set('prompt', 'select_account'); // add-account flow
  return hubLogin.toString();
}
