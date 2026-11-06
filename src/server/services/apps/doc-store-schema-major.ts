// The schema major a production document write is stamped with: the collection's current major,
// derived by the shared rule (`storage-schema-majors.ts`) from the app's approved manifest history
// plus its enforced manifest — the same history, in the same order, the registry adapter derives
// its majors from. The store itself never reads the main database; its callers resolve the major
// here and hand it over on the collection (`DocCollection.schemaMajor`).
//
// The history is read only when the enforced manifest changed since the last derivation for that
// app (an approve writes a new one), so a write normally costs a map lookup. A failure to derive
// never refuses the write: the major is then `null` (not known), and the error is logged.
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ApprovedManifest } from '~/server/services/apps/storage-schema-majors';
import {
  currentCollectionMajors,
  deriveCollectionMajors,
  manifestHistory,
} from '~/server/services/apps/storage-schema-majors';

export type SchemaMajorResolver = (args: {
  appBlockId: string;
  /** The enforced manifest (`app_blocks.manifest`) the caller resolved the collection from. */
  head: unknown;
  collection: string;
}) => Promise<number | null>;

/** Apps whose derivation is kept; the oldest is dropped past this. */
const CACHE_APPS = 1000;

export function createSchemaMajorResolver(deps: {
  /** The app's approved publish requests, any order. */
  readApproved: (appBlockId: string) => Promise<ApprovedManifest[]>;
  onError?: (err: unknown, appBlockId: string) => void;
}): SchemaMajorResolver {
  // appBlockId → the majors derived for the enforced manifest `headKey`. Keyed on the head, not
  // on time: a rollback to an older manifest is a new head here, and so a new derivation.
  const cache = new Map<string, { headKey: string; majors: ReadonlyMap<string, number> }>();

  return async ({ appBlockId, head, collection }) => {
    try {
      const headKey = JSON.stringify(head ?? null);
      let entry = cache.get(appBlockId);
      if (!entry || entry.headKey !== headKey) {
        const approved = (await deps.readApproved(appBlockId)) ?? [];
        entry = {
          headKey,
          majors: currentCollectionMajors(deriveCollectionMajors(manifestHistory(approved, head))),
        };
        cache.delete(appBlockId);
        cache.set(appBlockId, entry);
        if (cache.size > CACHE_APPS) cache.delete(cache.keys().next().value as string);
      }
      return entry.majors.get(collection) ?? null;
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
