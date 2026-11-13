// The schema major a production document write is stamped with: the collection's current major,
// derived by the shared rule (`storage-schema-majors.ts`) from the app's approved manifest history
// plus its enforced manifest — the same history, in the same order, the registry adapter derives
// its majors from. The store itself never reads the main database; its callers resolve the major
// here and hand it over on the collection (`DocCollection.schemaMajor`).
//
// Cached per app, keyed on the enforced manifest's REVISION (`app_blocks.updated_at`, which every
// write of the row bumps, an approve's manifest write and a rollback's included), so a write
// normally costs a map lookup and the manifest itself is never serialised or kept: an entry holds
// only the derived majors. Concurrent misses for one revision share a single derivation. A failure
// to derive never refuses the write: the major is then `null` (not known), and the error is
// logged.
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ApprovedManifest } from '~/server/services/apps/storage-schema-majors';
import {
  currentCollectionMajors,
  deriveCollectionMajors,
  manifestHistory,
} from '~/server/services/apps/storage-schema-majors';

/** An app's enforced manifest (`app_blocks.manifest`) and the revision of the row it came from. */
export type EnforcedManifest = {
  manifest: unknown;
  /** `app_blocks.updated_at` as an ISO string; null when unknown, which disables caching. */
  revision: string | null;
};

/** The enforced manifest of an `app_blocks` row read with `manifest` and `updatedAt`. */
export function enforcedManifestOf(
  row: { manifest: unknown; updatedAt?: Date | null } | null | undefined
): EnforcedManifest | undefined {
  if (!row) return undefined;
  return { manifest: row.manifest, revision: row.updatedAt?.toISOString() ?? null };
}

export type SchemaMajorResolver = (args: {
  appBlockId: string;
  /** The enforced manifest the caller resolved the collection from. None: no major. */
  head: EnforcedManifest | undefined;
  collection: string;
}) => Promise<number | null>;

/** Apps whose derivation is kept; the oldest is dropped past this. */
const CACHE_APPS = 1000;

type Majors = ReadonlyMap<string, number>;

export function createSchemaMajorResolver(deps: {
  /** The app's approved publish requests, any order. */
  readApproved: (appBlockId: string) => Promise<ApprovedManifest[]>;
  onError?: (err: unknown, appBlockId: string) => void;
}): SchemaMajorResolver {
  // appBlockId → the majors derived for one revision of its enforced manifest.
  const cache = new Map<string, { revision: string; majors: Promise<Majors> }>();

  async function derive(appBlockId: string, manifest: unknown): Promise<Majors> {
    const approved = (await deps.readApproved(appBlockId)) ?? [];
    return currentCollectionMajors(deriveCollectionMajors(manifestHistory(approved, manifest)));
  }

  function majorsFor(appBlockId: string, head: EnforcedManifest): Promise<Majors> {
    if (head.revision === null) return derive(appBlockId, head.manifest);
    const hit = cache.get(appBlockId);
    if (hit && hit.revision === head.revision) return hit.majors;
    const entry = { revision: head.revision, majors: derive(appBlockId, head.manifest) };
    cache.delete(appBlockId);
    cache.set(appBlockId, entry);
    if (cache.size > CACHE_APPS) cache.delete(cache.keys().next().value as string);
    // A failed derivation is not kept: the next write tries again.
    entry.majors.catch(() => {
      if (cache.get(appBlockId) === entry) cache.delete(appBlockId);
    });
    return entry.majors;
  }

  return async ({ appBlockId, head, collection }) => {
    if (!head) return null;
    try {
      return (await majorsFor(appBlockId, head)).get(collection) ?? null;
    } catch (err) {
      deps.onError?.(err, appBlockId);
      return null;
    }
  };
}

/** The approved history from the read replica, where `app_blocks.manifest` was read too. */
export const resolveSchemaMajor: SchemaMajorResolver = createSchemaMajorResolver({
  readApproved: (appBlockId) =>
    dbRead.appBlockPublishRequest.findMany({
      where: { appBlockId, status: 'approved' },
      select: { id: true, manifest: true, reviewedAt: true },
    }),
  onError: (err, appBlockId) => {
    logToAxiom(
      {
        name: 'app-blocks-doc-store-schema-major-failed',
        type: 'error',
        appBlockId,
        message: err instanceof Error ? err.message : String(err),
      },
      'app-blocks'
    ).catch(() => undefined);
  },
});
