import { hubLoginUrl } from '@civitai/auth/client';

// THE single builder for the hub login entry URL. Now SERVER-SIDE only — used by `/login`
// (`src/server/auth/login-redirect.ts`) and the `/api/auth/login-popup` endpoint, both of which build the URL
// from the server's `AUTH_JWT_ISSUER`. (The client popup/connect/discord-link paths used to call this directly
// with `NEXT_PUBLIC_AUTH_HUB_URL`; they now navigate to those same-origin server endpoints instead, so there's
// no client-side hub origin anymore.)
//
// UNIFIED login landing (Phase 4): EVERY color lands on its OWN `/api/auth/authorize`, which runs the OAuth
// authorization-code flow against the hub and mints THIS domain's own civ-token cookie — so same-site (.com)
// no longer depends on the shared `.civitai.com` cookie, and cross-site (.red) works identically. The hub
// `/login` stays the entry point, so `reason` / `error` / `prompt=select_account` (add-account) still apply.
export function buildHubLoginUrl(opts: {
  origin: string; // the spoke's OWN origin (the request host)
  hub: string; // the hub origin (the server's AUTH_JWT_ISSUER)
  dest: string; // post-login destination (a safe same-origin path)
  reason?: string;
  error?: string;
  selectAccount?: boolean;
}): string {
  const { origin, hub, dest, reason, error, selectAccount } = opts;
  // post-login runs the side-effects the hub can't (ref_* cookies + tracking/referral) then forwards to dest.
  // `reason` rides the post-login path for attribution.
  const reasonQuery = reason ? `&reason=${encodeURIComponent(reason)}` : '';
  const postLoginPath = `/api/auth/post-login?dest=${encodeURIComponent(dest)}${reasonQuery}`;
  const landing = `${origin}/api/auth/authorize?returnUrl=${encodeURIComponent(postLoginPath)}`;
  return hubLoginUrl(hub, {
    returnUrl: landing,
    reason, // hub login-funnel analytics
    error, // shown on the hub login page
    prompt: selectAccount ? 'select_account' : undefined, // add-account flow
  });
}
