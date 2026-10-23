import { browser } from '$app/environment';
import type { SidebarCountsResult } from '$lib/server/sidebar-counts.service';

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
      const body: Partial<SidebarCountsResult> = await r.json();
      store.value = body.counts ?? {};
      store.unavailable = body.unavailable ?? [];
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
