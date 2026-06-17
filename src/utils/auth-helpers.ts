import { hubLoginUrl } from '@civitai/auth/client';
import { env } from '~/env/client';

// All authentication is centralized at the hub (auth.civitai.com) — the HUB's login UI sets the session cookie;
// the main app never mints one. These helpers just navigate (or pop up) to the hub login.
const HUB = env.NEXT_PUBLIC_AUTH_HUB_URL;

// 2-label registrable domain (civitai.com / civitai.red), to tell same-site from cross-site relative to the hub.
function registrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname.toLowerCase();
}

/**
 * The hub login entry URL that lands back on `dest` once login completes. The hub sets its own `.civitai.com`
 * cookie; on a CROSS-SITE host (civitai.red) that cookie isn't readable here, so the landing first runs the
 * existing swap-token sync (/api/auth/sync) to mint THIS domain's cookie — then post-login side-effects, then
 * `dest`. Same hub mechanism that works full-page; we just choose where it lands.
 */
function hubLoginEntryUrl(hub: string, dest: string, reason?: string): string {
  const origin = window.location.origin;
  // `reason` is embedded in the post-login path (attribution on completion) AND passed as a hub param below
  // (the hub's LoginRedirect analytics).
  const postLoginPath = `/api/auth/post-login?dest=${encodeURIComponent(dest)}${
    reason ? `&reason=${encodeURIComponent(reason)}` : ''
  }`;
  const crossSite =
    registrableDomain(window.location.hostname) !== registrableDomain(new URL(hub).hostname);
  const landing = crossSite
    ? `${origin}/api/auth/sync?returnUrl=${encodeURIComponent(postLoginPath)}`
    : `${origin}${postLoginPath}`;
  return hubLoginUrl(hub, { returnUrl: landing, reason });
}

/** Same-origin BroadcastChannel the popup-done page signals on, so the opener (and the email magic-link tab, which
 *  has no opener) can coordinate. */
export const LOGIN_POPUP_CHANNEL = 'civitai-login';
export const LOGIN_POPUP_DONE = 'civitai-login-popup-done';

/**
 * Open the hub login (`auth.civitai.com/login`) in a POPUP window. The hub runs its normal login flow (providers
 * + email) and sets the cookie, then lands on the same-origin `/login/popup-done` page. That page broadcasts
 * `LOGIN_POPUP_DONE`; we close the popup and navigate this (the originating) tab to `callbackUrl` — the page the
 * user started from. Falls back to a full-page login if the popup is blocked.
 */
export function openLoginPopup(callbackUrl: string, reason?: string) {
  if (typeof window === 'undefined') return;
  if (!HUB) {
    // eslint-disable-next-line no-console
    console.error('[auth] NEXT_PUBLIC_AUTH_HUB_URL is not set — login cannot start.');
    return;
  }
  // popup-done sends the email magic-link tab back to where login started — carry it as `cb`.
  const dest = `/login/popup-done?cb=${encodeURIComponent(callbackUrl)}`;
  const url = hubLoginEntryUrl(HUB, dest, reason);
  // Center the popup on the current browser window (screenX/Y + outer size handle multi-monitor setups).
  const width = 480;
  const height = 760;
  const left = Math.round(window.screenX + Math.max(0, (window.outerWidth - width) / 2));
  const top = Math.round(window.screenY + Math.max(0, (window.outerHeight - height) / 2));
  const popup = window.open(
    url,
    'civitai-login',
    `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no`
  );
  if (!popup) {
    window.location.href = hubLoginEntryUrl(HUB, callbackUrl, reason); // blocked → full-page, lands on callbackUrl
    return;
  }
  const channel = new BroadcastChannel(LOGIN_POPUP_CHANNEL);
  // Tear down on completion OR when the popup is closed/abandoned — otherwise a stale listener would linger and
  // a later login could fire it, navigating to the wrong page.
  let poll: ReturnType<typeof setInterval>;
  const cleanup = () => {
    clearInterval(poll);
    channel.close();
  };
  poll = setInterval(() => {
    if (popup.closed) cleanup();
  }, 500);
  channel.onmessage = (e) => {
    if ((e.data as { type?: string } | null)?.type !== LOGIN_POPUP_DONE) return;
    cleanup();
    try {
      popup.close();
    } catch {
      /* may already be closed */
    }
    window.location.assign(callbackUrl); // back to where they started, now signed in
  };
}

/**
 * Sign out via the main app's /api/auth/logout, which clears the hub's civ-token (+ the legacy cookie + the
 * orchestrator cookie) and best-effort revokes the token at the hub, then redirects. See cutover doc (B).
 *
 * Default behavior: redirect back to the CURRENT page, which reloads it signed-out. If that page requires
 * authentication, its own guard (getServerSideProps redirect / requireLogin) sends the user to a public page —
 * so we don't special-case it here. Callers can pass an explicit `callbackUrl` to land somewhere specific.
 */
export function handleSignOut(options: { callbackUrl?: string } = {}) {
  if (typeof window === 'undefined') return Promise.resolve();
  const here = window.location.pathname + window.location.search + window.location.hash;
  const callbackUrl = options.callbackUrl ?? here;
  const url = new URL('/api/auth/logout', window.location.origin);
  url.searchParams.set('callbackUrl', callbackUrl);
  window.location.href = url.toString();
  return Promise.resolve();
}
