// The hub login-route contract — the single source of the URL shape the main app uses to deep-link to the hub
// login, so it never hardcodes `${hub}/login/<provider>?…`. Provider OAuth config/secrets live hub-side
// (apps/auth .../providers.ts); the provider id→name/icon descriptors live in their sole consumer (the main
// app's AccountsCard) since the hub renders its own login UI.

/** Canonical upstream-provider id union — the hub keys its provider config (apps/auth) on this. */
export type ProviderId = 'discord' | 'google' | 'github' | 'reddit';

export interface HubLoginUrlOptions {
  /** Deep-link to a specific provider's flow (`/login/<provider>`); omit for the hub login picker page. */
  provider?: string;
  /** Where to land after the hub authenticates (absolute or root-relative). */
  returnUrl?: string;
  /** Account-LINKING intent ("Connect <provider>") — the hub requires an active session and attaches the
   *  provider to the current user instead of logging in. */
  link?: boolean;
  /** Request the provider's incremental scope (Discord Linked Roles — `role_connections.write`). Only the
   *  /discord/link-role flow sets this; plain login/connect never does, so a normal login can't fail on the
   *  Linked-Roles scope. Pairs with `link: true`. */
  linkRoles?: boolean;
  /** Forwarded to the provider's authorization URL, e.g. `select_account` to force its account chooser. */
  prompt?: string;
  /** Why the user was sent to log in (e.g. `image-gen`). The hub tracks tracked reasons as a `LoginRedirect`
   *  event — the same login-funnel analytics the main app's in-page login used to emit. */
  reason?: string;
  /** An error code to surface on the hub login page (e.g. `OAuthAccountNotLinked`). */
  error?: string;
}

/** Build a hub login URL. `hubBase` is the hub origin (the main app passes `NEXT_PUBLIC_AUTH_HUB_URL`). */
export function hubLoginUrl(hubBase: string, opts: HubLoginUrlOptions = {}): string {
  const url = new URL(opts.provider ? `/login/${opts.provider}` : '/login', hubBase);
  if (opts.returnUrl) url.searchParams.set('returnUrl', opts.returnUrl);
  if (opts.link) url.searchParams.set('link', 'true');
  if (opts.linkRoles) url.searchParams.set('roles', 'true');
  if (opts.prompt) url.searchParams.set('prompt', opts.prompt);
  if (opts.reason) url.searchParams.set('reason', opts.reason);
  if (opts.error) url.searchParams.set('error', opts.error);
  return url.toString();
}

/**
 * Build the hub LOGOUT landing URL (a top-level GET). A cross-site spoke (e.g. civitai.red) can't clear the
 * hub's `.civitai.com` cookies or revoke the hub session itself, and can't POST the hub's logout directly
 * (cross-origin form POST is CSRF-blocked), so it sends the browser HERE; the hub's GET landing then auto-POSTs
 * same-origin to finish logout and redirects back to `returnUrl`. `returnUrl` is the absolute spoke URL to land
 * on after — the hub validates it against the trusted-spoke registry before redirecting (no open redirect).
 */
export function hubLogoutUrl(hubBase: string, returnUrl?: string): string {
  const url = new URL('/logout', hubBase);
  if (returnUrl) url.searchParams.set('returnUrl', returnUrl);
  return url.toString();
}
