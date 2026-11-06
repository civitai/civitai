import { browser } from '$app/environment';
import { parseSidebarCounts } from './sidebar-counts-response';

// Fetched client-side (not via SSR load) so the count aggregates never sit in the page-load request path.
const TTL_MS = 60_000;

/** Fetched on demand, at most once per TTL; a failed fetch keeps the prior value and retries next call. */
function ttlFetched<T>(url: string, parse: (json: unknown) => T = (json) => json as T) {
  const store = $state<{ value: T | null }>({ value: null });
  let lastFetch = 0;
  let inflight = false;

  async function refresh() {
    if (!browser || inflight) return;
    if (lastFetch && Date.now() - lastFetch < TTL_MS) return;
    inflight = true;
    try {
      const r = await fetch(url);
      if (r.ok) {
        store.value = parse(await r.json());
        lastFetch = Date.now();
      }
    } catch {
      // keep the prior value; the next navigation retries
    } finally {
      inflight = false;
    }
  }

  return { store, refresh };
}

const counts = ttlFetched('/api/sidebar-counts', parseSidebarCounts);
const lastActioned = ttlFetched<Record<string, { at: string; by: string | null }>>(
  '/api/sidebar-last-actioned'
);
const queueOldest = ttlFetched<Record<string, string>>('/api/queue-oldest');

const countsView = {
  get value() {
    return counts.store.value?.counts ?? null;
  },
  get unavailable() {
    return counts.store.value?.unavailable ?? [];
  },
};

export function sidebarCounts() {
  void counts.refresh();
  return countsView;
}

/** `countKey` → when, and by whom, a moderator last actioned that queue; absent when there is none. */
export function sidebarLastActioned() {
  void lastActioned.refresh();
  return lastActioned.store;
}

/** `countKey` → when its oldest waiting report was filed; absent when nothing is waiting. */
export function sidebarQueueOldest() {
  void queueOldest.refresh();
  return queueOldest.store;
}

export function refreshSidebarCounts() {
  void counts.refresh();
  void lastActioned.refresh();
  void queueOldest.refresh();
}
