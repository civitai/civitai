import { browser } from '$app/environment';

// Sidebar triage counts, fetched CLIENT-SIDE (not via SSR load) so the count aggregates never sit in the
// page-load request path. One shared store: the layout and the /images hub both read `value` (null until
// the first fetch resolves — badges just don't render yet). The layout calls refresh() on navigation so
// counts drop as queues are cleared; a client-side TTL dedupes rapid navigation (the endpoint also caches
// 60s server-side).
const TTL_MS = 60_000;
const store = $state<{ value: Record<string, number> | null }>({ value: null });
let lastFetch = 0;
let inflight = false;

async function fetchCounts() {
  if (!browser || inflight) return;
  if (lastFetch && Date.now() - lastFetch < TTL_MS) return;
  inflight = true;
  try {
    const r = await fetch('/api/sidebar-counts');
    if (r.ok) {
      store.value = await r.json();
      lastFetch = Date.now();
    }
  } catch {
    // keep the prior value; the next navigation retries
  } finally {
    inflight = false;
  }
}

export function sidebarCounts() {
  void fetchCounts();
  return store;
}

export function refreshSidebarCounts() {
  void fetchCounts();
}
