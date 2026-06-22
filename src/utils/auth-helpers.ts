// All authentication is centralized at the hub (auth.civitai.com) — the HUB's login UI sets the session cookie;
// the main app never mints one. These helpers navigate (or pop up) to login via the MAIN SERVER: /login and
// /api/auth/login-popup build the hub URL with the server's AUTH_JWT_ISSUER, so there's no client-side hub env
// var to set (or to silently no-op when missing).

/** Same-origin POPUP login entry — the main server redirects to the hub, landing on /login/popup-done. */
function loginPopupUrl(callbackUrl: string, reason?: string): string {
  const u = new URL('/api/auth/login-popup', window.location.origin);
  u.searchParams.set('cb', callbackUrl);
  if (reason) u.searchParams.set('reason', reason);
  return u.toString();
}

/** Same-origin FULL-PAGE login — the main server's /login redirect, landing back on `dest`. */
function fullPageLoginUrl(dest: string, reason?: string): string {
  const u = new URL('/login', window.location.origin);
  u.searchParams.set('returnUrl', dest);
  if (reason) u.searchParams.set('reason', reason);
  return u.toString();
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
  // The main server builds the hub URL (whose post-login dest is /login/popup-done) — we just open same-origin.
  const url = loginPopupUrl(callbackUrl, reason);
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
    window.location.href = fullPageLoginUrl(callbackUrl, reason); // blocked → full-page, lands on callbackUrl
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
