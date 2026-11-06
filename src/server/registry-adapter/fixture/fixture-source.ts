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
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

export type FixtureCatalog = {
  scope?: StoreVisibilityScope;
  listings: CatalogListing[];
  blocks?: CatalogBlock[];
  approved?: Array<Omit<CatalogApprovedRequest, 'reviewedAt'> & { reviewedAt: string | null }>;
  sourceRepoUrls?: Record<string, string>;
};

export function fixtureCatalogDeps(read: () => FixtureCatalog): CatalogReadDeps {
  return {
    resolveScope: async () => read().scope ?? 'full',
    listPage: async () => ({ items: read().listings }),
    loadBlocks: async (ids) => (read().blocks ?? []).filter((b) => ids.includes(b.id)),
    loadApproved: async (ids) =>
      (read().approved ?? [])
        .filter((r) => ids.includes(r.appBlockId))
        .map((r) => ({ ...r, reviewedAt: r.reviewedAt ? new Date(r.reviewedAt) : null })),
    loadSourceRepoUrl: async (listingId) => read().sourceRepoUrls?.[listingId] ?? null,
  };
}

export function fixtureFile(path: string): () => FixtureCatalog {
  return () => JSON.parse(readFileSync(path, 'utf8')) as FixtureCatalog;
}

export function createMemorySnapshotStore(): SnapshotStore {
  const sets = new Map<string, string>();
  return {
    get: async (digest) => sets.get(digest) ?? null,
    put: async (digest, value) => void sets.set(digest, value),
  };
}
