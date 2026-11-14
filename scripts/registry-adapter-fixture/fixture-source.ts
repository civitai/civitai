/**
 * A fixture catalog for running the adapter against a local registry or conformance harness
 * without a database or Redis. Development only: `fixture/main.ts` refuses to start in
 * production, and the live entrypoint never imports this.
 *
 * The catalog is a JSON file re-read on every poll, so editing it while a consumer watches is
 * how a change reaches the stream.
 */
import { readFileSync } from 'node:fs';
import type {
  CatalogApprovedRequest,
  CatalogBlock,
  CatalogListing,
  CatalogReadDeps,
} from '~/server/registry-adapter/catalog-source';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { STATES_KEPT_PER_STREAM, retainLatest } from '~/server/registry-adapter/cursor';
import type { SharedDocSource } from '~/server/registry-adapter/doc-feed';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

export type FixtureCatalog = {
  scope?: StoreVisibilityScope;
  listings: CatalogListing[];
  blocks?: CatalogBlock[];
  approved?: Array<Omit<CatalogApprovedRequest, 'reviewedAt'> & { reviewedAt: string | null }>;
  sourceRepoUrls?: Record<string, string>;
  /** Listing id → the icon url its app publishes (already gated in the fixture). */
  icons?: Record<string, string>;
  /** Fork listing id → the listing id it was forked from (which need not be in `listings`). */
  forkOf?: Record<string, string>;
  /** App Storage rows, as the store holds them: every namespace and key space. */
  documents?: Array<{
    appId: string;
    ns: string;
    coll: string;
    scopeUid: number;
    key: string;
    data: Record<string, unknown>;
    version: number;
    seq: number;
    hidden?: boolean;
  }>;
  tombstones?: Array<{
    appId: string;
    ns: string;
    coll: string;
    scopeUid: number;
    key: string;
    seq: number;
  }>;
  /** Each app's production namespace `last_seq`. */
  lastSeq?: Record<string, number>;
};

/**
 * The store's feed reads over the fixture rows, with the same predicates the store's SQL fixes:
 * the production namespace and the shared key space only.
 */
export function fixtureDocSource(read: () => FixtureCatalog): SharedDocSource {
  const shared = (appId: string, coll: string) => {
    const c = read();
    const mine = <T extends { appId: string; ns: string; coll: string; scopeUid: number }>(
      rows: T[] = []
    ) =>
      rows.filter(
        (r) => r.appId === appId && r.ns === 'prod' && r.coll === coll && r.scopeUid === 0
      );
    return { docs: mine(c.documents), tombs: mine(c.tombstones) };
  };
  const strip = <
    T extends { key: string; data: Record<string, unknown>; version: number; seq: number }
  >(
    d: T
  ) => ({
    key: d.key,
    data: d.data,
    version: d.version,
    seq: d.seq,
  });
  return {
    head: async (appId) => read().lastSeq?.[appId] ?? 0,
    changes: async (appId, coll, after, upTo, limit) => {
      const { docs, tombs } = shared(appId, coll);
      const inRange = (seq: number) => seq > after && seq <= upTo;
      return {
        docs: docs
          .filter((d) => inRange(d.seq))
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map((d) => ({ ...strip(d), hidden: d.hidden === true })),
        tombs: tombs
          .filter((t) => inRange(t.seq))
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map((t) => ({ key: t.key, seq: t.seq })),
      };
    },
    documents: async (appId, coll, afterKey, upTo, limit) =>
      shared(appId, coll)
        .docs.filter((d) => !d.hidden && d.seq <= upTo && d.key > afterKey)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, limit)
        .map(strip),
    witness: async (appId, coll, key) => {
      const { docs, tombs } = shared(appId, coll);
      return {
        docSeq: docs.find((d) => d.key === key)?.seq ?? null,
        tombSeq: tombs.find((t) => t.key === key)?.seq ?? null,
      };
    },
  };
}

export function fixtureCatalogDeps(read: () => FixtureCatalog): CatalogReadDeps {
  return {
    resolveScope: async () => read().scope ?? 'full',
    listPage: async () => ({ items: read().listings }),
    loadBlocks: async (ids) => (read().blocks ?? []).filter((b) => ids.includes(b.id)),
    loadApproved: async (ids) =>
      (read().approved ?? [])
        .filter((r) => ids.includes(r.appBlockId))
        .map((r) => ({ ...r, reviewedAt: r.reviewedAt ? new Date(r.reviewedAt) : null })),
    loadSourceRepoUrls: async (ids) =>
      new Map(ids.map((id) => [id, read().sourceRepoUrls?.[id] ?? null])),
    loadIconUrls: async (ids) => new Map(ids.map((id) => [id, read().icons?.[id] ?? null])),
    loadForkParents: async (ids) =>
      new Map(ids.flatMap((id) => (read().forkOf?.[id] ? [[id, read().forkOf![id]]] : []))),
  };
}

export function fixtureFile(path: string): () => FixtureCatalog {
  return () => JSON.parse(readFileSync(path, 'utf8')) as FixtureCatalog;
}

/**
 * The in-memory {@link SnapshotStore}, with the same per-stream bound as the Redis one. Fixture
 * mode runs on it, and so do the adapter's tests: `gets`, `puts`, `touches`, `size` and `clear`
 * are for them.
 */
export function createMemorySnapshotStore(keep: number = STATES_KEPT_PER_STREAM): SnapshotStore & {
  gets(): number;
  puts(): number;
  touches(): number;
  size(): number;
  clear(): void;
} {
  const sets = new Map<string, string>();
  const streams = new Map<string, string[]>();
  let gets = 0;
  let puts = 0;
  let touches = 0;
  const retain = (digest: string, stream: string) => {
    const { list, evicted } = retainLatest(streams.get(stream) ?? [], digest, keep);
    streams.set(stream, list);
    for (const old of evicted) sets.delete(old);
  };
  return {
    get: async (digest) => {
      gets++;
      return sets.get(digest) ?? null;
    },
    put: async (digest, value, stream) => {
      puts++;
      sets.set(digest, value);
      retain(digest, stream);
    },
    touch: async (digest, stream) => {
      touches++;
      retain(digest, stream);
    },
    gets: () => gets,
    puts: () => puts,
    touches: () => touches,
    size: () => sets.size,
    clear: () => {
      sets.clear();
      streams.clear();
    },
  };
}
