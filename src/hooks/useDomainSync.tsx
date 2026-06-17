import { useEffect } from 'react';
import { SYNC_PARAM } from '@civitai/auth/client';

// Cross-domain login bootstrap trigger (section E). When a page loads carrying the sync marker (set by the hub
// login redirect after authenticating, or by a "sign in on this domain" link), hand off to the server-side
// /api/auth/sync flow: it bounces through the hub (top-level nav, so the hub's cookie is read) and comes back
// with a swap token it exchanges for THIS domain's civ-token. The marker is stripped from the returnUrl so the
// post-sync landing doesn't loop back here. All the credential handling is server-side — this just navigates.
let isSyncing = false;

export function useDomainSync() {
  useEffect(() => {
    if (isSyncing || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const sync = url.searchParams.get(SYNC_PARAM);
    if (!sync) return;
    isSyncing = true;

    url.searchParams.delete(SYNC_PARAM);
    const returnUrl = `${url.pathname}${url.search}${url.hash}`;
    window.location.replace(`/api/auth/sync?returnUrl=${encodeURIComponent(returnUrl)}`);
  }, []);
}
