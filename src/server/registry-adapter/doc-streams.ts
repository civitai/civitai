/**
 * Which collection-major streams are published, decided from the same catalog read as every other
 * entity: the app is listed in the public catalog, its block is approved, its enforced manifest
 * opts the collection in (`registry: "public"`), and the major exists.
 */
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { appContentRating } from '~/server/registry-adapter/entities';
import {
  HEAD_STEP,
  collectionSchemaDocuments,
  deriveCollectionMajors,
  exportedCollections,
} from '~/server/registry-adapter/collection-schema';
import type {
  CollectionStream,
  ResolveStream,
  createDocFeed,
} from '~/server/registry-adapter/doc-feed';
import type { Adapter } from '~/server/registry-adapter/protocol';
import { parseCollectionSchemaUrn, registryUrn } from '~/server/registry-adapter/urn';
import type { AppStorageFeature } from '~/shared/constants/block-storage.constants';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';

/**
 * `features` is the platform's live switch, the same one submit validates against. Nothing is
 * published while `registryExport` is off, even from an approved manifest that already declares
 * `registry: "public"` ({@link exportedCollections}, the same rule the catalog's schema entities
 * use).
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
    if (!exportedCollections(app.block.manifest, features).has(ref.collection)) return null;

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
    return {
      appId: app.block.id,
      slug: ref.slug,
      collection: ref.collection,
      // The rating the app entity publishes, which is every document's.
      contentRating: appContentRating(app),
      family,
    };
  };
}

/**
 * One source: the entity streams (the app, release and schema streams narrowed per audience, as
 * the document streams are, `cursor.ts`), and a document stream for every collection-schema URN of
 * this namespace, routed by its shape alone (no entity schema has one, `urn.ts`). Every such URN is
 * served, since its major may be published later; one not published now streams empty. `end` is
 * only for a schema this source can never serve.
 */
export function composeAdapter(entities: Adapter, docs: ReturnType<typeof createDocFeed>): Adapter {
  const isDocStream = (schema: string) => parseCollectionSchemaUrn(schema) !== null;
  return {
    namespace: entities.namespace,
    serves: (schema) => isDocStream(schema) || entities.serves(schema),
    snapshot: (schema, ctx) =>
      isDocStream(schema) ? docs.snapshot(schema, ctx) : entities.snapshot(schema, ctx),
    changes: (schema, cursor, ctx) =>
      isDocStream(schema)
        ? docs.changes(schema, cursor, ctx)
        : entities.changes(schema, cursor, ctx),
  };
}
