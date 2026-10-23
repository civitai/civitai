import { browser } from '$app/environment';

// Fetched client-side (not via SSR load) so the count aggregates never sit in the page-load request path.
const TTL_MS = 60_000;
const store = $state<{ value: Record<string, number> | null; unavailable: string[] }>({
  value: null,
  unavailable: [],
});
let lastFetch = 0;
let inflight = false;

async function fetchCounts() {
  if (!browser || inflight) return;
  if (lastFetch && Date.now() - lastFetch < TTL_MS) return;
  inflight = true;
  try {
    const r = await fetch('/api/sidebar-counts');
    if (r.ok) {
      // The counts, with the keys the server could not count beside them (an older server sends none).
      const { unavailable, ...counts }: Record<string, unknown> = await r.json();
      store.value = counts as Record<string, number>;
      store.unavailable = Array.isArray(unavailable) ? unavailable : [];
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
