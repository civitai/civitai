/**
 * Which collection-major streams are published, decided from the same catalog read as every other
 * entity: the app is listed in the public catalog, its block is approved, its enforced manifest
 * opts the collection in (`registry: "public"`), and the major exists.
 */
import type { CatalogApp } from '~/server/registry-adapter/entities';
import {
  HEAD_STEP,
  collectionSchemaDocuments,
  deriveCollectionMajors,
} from '~/server/registry-adapter/collection-schema';
import type {
  CollectionStream,
  ResolveStream,
  createDocFeed,
} from '~/server/registry-adapter/doc-feed';
import type { Adapter } from '~/server/registry-adapter/protocol';
import { parseCollectionSchemaUrn, registryUrn } from '~/server/registry-adapter/urn';
import type { AppStorageFeature } from '~/shared/constants/block-storage.constants';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  APP_STORAGE_ENABLED_FEATURES,
  isCollectionRegistryPublic,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';

/**
 * `features` is the platform's live switch, the same one submit validates against. Nothing is
 * published while `registryExport` is off, even from an approved manifest that already declares
 * `registry: "public"`: the manifest's SHAPE is read with every feature on (an approved
 * manifest stays parseable when a feature it uses is switched off, as the store reads it), but
 * whether the feature may act is this switch alone.
 */
export function resolveFromCatalog(
  readApps: () => Promise<CatalogApp[]>,
  features: Readonly<Record<AppStorageFeature, boolean>> = APP_STORAGE_ENABLED_FEATURES
): ResolveStream {
  return async (schema) => {
    if (!features.registryExport) return null;
    const ref = parseCollectionSchemaUrn(schema);
    if (!ref) return null;
    const app = (await readApps()).find(
      (a) => a.block?.blockId === ref.slug && a.block.status === 'approved'
    );
    if (!app?.block) return null;
    const declared = parseManifestStorage(
      app.block.manifest,
      APP_STORAGE_ALL_FEATURES_ON
    ).collections.get(ref.collection);
    if (!declared || !isCollectionRegistryPublic(declared)) return null;

    const derivation = deriveCollectionMajors([
      ...app.approved.map((r) => ({ id: r.id, manifest: r.manifest })),
      { id: HEAD_STEP, manifest: app.block.manifest },
    ]);
    const majors = derivation.collections.get(ref.collection)?.majors.length ?? 0;
    if (ref.major > majors) return null;
    const familyUrns = new Set(
      Array.from({ length: majors }, (_, i) =>
        registryUrn({
          kind: 'collection-schema',
          slug: ref.slug,
          collection: ref.collection,
          major: i + 1,
        })
      )
    );
    const family: CollectionStream['family'] = collectionSchemaDocuments(
      ref.slug,
      derivation
    ).filter((d) => familyUrns.has(d.urn));
    return { appId: app.block.id, slug: ref.slug, collection: ref.collection, family };
  };
}

/** One source: the entity streams, and a document stream for every collection-schema URN. */
export function composeAdapter(entities: Adapter, docs: ReturnType<typeof createDocFeed>): Adapter {
  const isDocStream = (schema: string) =>
    !entities.serves(schema) && parseCollectionSchemaUrn(schema) !== null;
  return {
    namespace: entities.namespace,
    serves: (schema) => entities.serves(schema) || isDocStream(schema),
    snapshot: (schema, ctx) =>
      isDocStream(schema) ? docs.snapshot(schema) : entities.snapshot(schema, ctx),
    changes: (schema, cursor, ctx) =>
      isDocStream(schema)
        ? docs.changes(schema, cursor, ctx)
        : entities.changes(schema, cursor, ctx),
  };
}
