import { useEffect } from 'react';
import { SYNC_PARAM, safeReturnPath } from '@civitai/auth/client';

// Cross-domain login bootstrap trigger (section E). When a page loads carrying the sync marker (set by the hub
// login redirect after authenticating, or by a "sign in on this domain" link), hand off to the server-side
// auth-code flow: /api/auth/authorize bounces through the hub's OAuth provider (top-level nav, so the hub's
// cookie is read) and /api/auth/callback exchanges the code for THIS domain's civ-token. The marker is
// stripped from the returnUrl so the post-login landing doesn't loop back here. All credential handling is
// server-side — this just navigates. (Replaces the bespoke swap-token bridge; same trigger, standard flow.)
let isSyncing = false;

// Where to land after the sync: a same-origin path the linking side asked for (e.g. the .red support-portal
// bounce sends `/support?sync-account=red&sync-redirect=/support-portal`), else the page we are on. The value is
// attacker-editable, so it goes through safeReturnPath (refuses schemes, `//host`, backslashes, control chars,
// anything resolving off-origin); /api/auth/authorize validates the returnUrl again server-side.
const SYNC_REDIRECT_PARAM = 'sync-redirect';

export function syncReturnUrl(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.get(SYNC_PARAM)) return null;
  const redirect = safeReturnPath(url.searchParams.get(SYNC_REDIRECT_PARAM));
  url.searchParams.delete(SYNC_PARAM);
  url.searchParams.delete(SYNC_REDIRECT_PARAM);
  return redirect ?? `${url.pathname}${url.search}${url.hash}`;
}

export function useDomainSync() {
  useEffect(() => {
    if (isSyncing || typeof window === 'undefined') return;
    const returnUrl = syncReturnUrl(window.location.href);
    if (!returnUrl) return;
    isSyncing = true;

    window.location.replace(`/api/auth/authorize?returnUrl=${encodeURIComponent(returnUrl)}`);
  }, []);
}
