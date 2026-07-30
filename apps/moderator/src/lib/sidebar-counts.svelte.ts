import { browser } from '$app/environment';

// Fetched client-side (not via SSR load) so the count aggregates never sit in the page-load request path.
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
