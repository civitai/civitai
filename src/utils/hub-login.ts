import { hubLoginUrl } from '@civitai/auth/client';

// THE single builder for the hub login entry URL — shared by the server `/login` redirect
// (`src/server/auth/login-redirect.ts`) and the client popup/full-page path (`src/utils/auth-helpers.ts`).
// Keeping it in one place removes the drift hazard that previously left the two builders out of sync (a
// Phase-3 regression where one still pointed at the deleted `/api/auth/sync`).
//
// UNIFIED login landing (Phase 4): EVERY color lands on its OWN `/api/auth/authorize`, which runs the OAuth
// authorization-code flow against the hub and mints THIS domain's own civ-token cookie — so same-site (.com)
// no longer depends on the shared `.civitai.com` cookie, and cross-site (.red) works identically. The hub
// `/login` stays the entry point, so `reason` / `error` / `prompt=select_account` (add-account) still apply.
export function buildHubLoginUrl(opts: {
  origin: string; // the spoke's OWN origin (request host server-side; window.location.origin client-side)
  hub: string; // the hub origin (AUTH_JWT_ISSUER server-side / NEXT_PUBLIC_AUTH_HUB_URL client-side)
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
