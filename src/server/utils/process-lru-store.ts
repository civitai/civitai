import type { LruStoreResolver } from '@civitai/redis';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiProcessLruStores: Map<string, unknown> | undefined;
}

/**
 * A store resolver that shares LRU backing stores process-wide, so the production server's several
 * bundler module graphs hold ONE copy of each L1 cache (and one byte budget — see l1-cache-budget.ts)
 * instead of one per graph.
 *
 * Call once per module evaluation. A store id requested twice through the SAME resolver is a second
 * cache in one graph that happens to share a name and sizing — two different caches, so it gets a
 * private store rather than another cache's entries.
 */
export function createProcessLruStoreResolver(): LruStoreResolver {
  const claimed = new Set<string>();
  return (id, create) => {
    if (claimed.has(id)) return create();
    claimed.add(id);
    const stores = (globalThis.__civitaiProcessLruStores ??= new Map());
    let store = stores.get(id) as ReturnType<typeof create> | undefined;
    if (!store) {
      store = create();
      stores.set(id, store);
    }
    return store;
  };
}
