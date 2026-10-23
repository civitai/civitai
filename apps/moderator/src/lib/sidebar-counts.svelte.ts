import { browser } from '$app/environment';

// Fetched client-side (not via SSR load) so the count aggregates never sit in the page-load request path.
const TTL_MS = 60_000;

/** Fetched on demand, at most once per TTL; a failed fetch keeps the prior value and retries next call. */
function ttlFetched<T>(url: string) {
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
        store.value = await r.json();
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

const counts = ttlFetched<Record<string, number>>('/api/sidebar-counts');
const lastActioned = ttlFetched<Record<string, string>>('/api/sidebar-last-actioned');

export function sidebarCounts() {
  void counts.refresh();
  return counts.store;
}

/** `countKey` → ISO time a moderator last actioned that queue; absent when there is none to show. */
export function sidebarLastActioned() {
  void lastActioned.refresh();
  return lastActioned.store;
}

export function refreshSidebarCounts() {
  void counts.refresh();
  void lastActioned.refresh();
}
