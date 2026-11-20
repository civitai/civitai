// An app's declared storage (collections and imports), parsed from its reviewed manifest with
// every phased feature on. Its own module so both the document-store resolver
// (`doc-store-access.ts`) and the collection-read predicate (`data-read-grant.ts`) read it without
// importing each other.
import { logToAxiom } from '~/server/logging/client';
import { recordStorageManifestUnparseable } from '~/server/metrics/app-block-runtime.metrics';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  parseManifestStorage,
  type DeclaredStorageCollections,
  type DeclaredStorageImports,
} from '~/shared/constants/block-storage.constants';

const loggedUnparseable = new Set<string>();

/** The declared storage, or a retryable 503 (logged once per app, counted every time). */
export function declaredStorage(
  appId: string,
  manifest: unknown
): { collections: DeclaredStorageCollections; imports: DeclaredStorageImports } {
  const parsed = parseManifestStorage(manifest, APP_STORAGE_ALL_FEATURES_ON);
  if (parsed.errors.length === 0) {
    return { collections: parsed.collections, imports: parsed.imports };
  }
  recordStorageManifestUnparseable();
  if (!loggedUnparseable.has(appId)) {
    loggedUnparseable.add(appId);
    logToAxiom(
      {
        name: 'app-blocks-doc-store-manifest-unparseable',
        type: 'error',
        appBlockId: appId,
        errors: parsed.errors.slice(0, 5),
      },
      'app-blocks'
    );
  }
  throw new DocStoreError('service_unavailable', 'storage is temporarily unavailable', {
    retryAfter: 30,
  });
}

/** The declared collections, or a retryable 503 (see {@link declaredStorage}). */
export function declaredCollections(appId: string, manifest: unknown): DeclaredStorageCollections {
  return declaredStorage(appId, manifest).collections;
}
