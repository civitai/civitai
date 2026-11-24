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
import type {
  ResolvePrivateStream,
  createPrivateDocFeed,
} from '~/server/registry-adapter/private-feed';
import { parseCollectionSchemaUrn, registryUrn } from '~/server/registry-adapter/urn';
import type { AppStorageFeature } from '~/shared/constants/block-storage.constants';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  APP_STORAGE_ENABLED_FEATURES,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';

/**
 * `features` is the platform's live switch, the same one submit validates against. Nothing is
 * published while `registryExport` is off, even from an approved manifest that already declares
 * `registry: "public"` ({@link exportedCollections}, the same rule the catalog's schema entities
 * use).
 */
export function resolveFromCatalog(
  readApps: () => Promise<CatalogApp[]>,
  features: Readonly<Record<AppStorageFeature, boolean>> = APP_STORAGE_ENABLED_FEATURES,
  /**
   * Content levels (`doc-levels.ts`). `docLevelsOn` says whether the flag is on for an app (off
   * unless given). With `requireDocLevels` — the DEFAULT, so a caller that says nothing fails
   * closed — an app whose flag is off publishes NOTHING: its documents are never exported
   * ungated. Only a test reading the export ungated passes `requireDocLevels: false`.
   */
  levels: {
    docLevelsOn?: (appBlockId: string) => Promise<boolean>;
    requireDocLevels?: boolean;
  } = {}
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

    const family = collectionFamily({ ...app, block: app.block }, ref);
    if (!family) return null;
    const docLevels = levels.docLevelsOn ? await levels.docLevelsOn(app.block.id) : false;
    if ((levels.requireDocLevels ?? true) && !docLevels) return null;
    return {
      appId: app.block.id,
      slug: ref.slug,
      collection: ref.collection,
      // The rating the app entity publishes; with content levels on, each document's own rating
      // also applies (`docLevels`).
      contentRating: appContentRating(app),
      family,
      ...(docLevels ? { docLevels: true } : {}),
    };
  };
}

/**
 * The private collection a stream schema names (`private-feed.ts`), from the same catalog read:
 * the app's block is approved, its enforced manifest declares the collection `visibility:
 * "private"`, and the major exists. It decides no access; the private feed's gates do.
 */
export function resolvePrivateFromCatalog(
  readApps: () => Promise<CatalogApp[]>
): ResolvePrivateStream {
  return async (schema) => {
    const ref = parseCollectionSchemaUrn(schema);
    if (!ref) return null;
    const app = (await readApps()).find(
      (a) => a.block?.blockId === ref.slug && a.block.status === 'approved'
    );
    if (!app?.block) return null;
    const declared = parseManifestStorage(app.block.manifest, APP_STORAGE_ALL_FEATURES_ON);
    if (declared.collections.get(ref.collection)?.visibility !== 'private') return null;
    const family = collectionFamily({ ...app, block: app.block }, ref);
    if (!family) return null;
    return { appId: app.block.id, slug: ref.slug, collection: ref.collection, family };
  };
}

/**
 * Every major's schema document of `ref.collection`, `@v1` first, derived from the app's approved
 * releases and its approved head; null when `ref.major` is not minted.
 */
export function collectionFamily(
  app: CatalogApp & { block: NonNullable<CatalogApp['block']> },
  ref: { slug: string; collection: string; major: number }
): CollectionStream['family'] | null {
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
  return collectionSchemaDocuments(ref.slug, derivation).filter((d) => familyUrns.has(d.urn));
}

/**
 * The authorized private document streams (`private-feed.ts`), when switched on: every collection-
 * schema URN of a collection its app declares `private` is snapshotted there, and every cursor it
 * issued resumes there. Everything else stays on the public feed.
 */
export type PrivateDocRoute = Pick<
  ReturnType<typeof createPrivateDocFeed>,
  'snapshot' | 'changes' | 'routes' | 'issued'
>;

/**
 * One source: the entity streams (the app, release and schema streams narrowed per audience, as
 * the document streams are, `cursor.ts`), and a document stream for every collection-schema URN of
 * this namespace, routed by its shape alone (no entity schema has one, `urn.ts`). Every such URN is
 * served, since its major may be published later; one not published now streams empty. `end` is
 * only for a schema this source can never serve.
 */
export function composeAdapter(
  entities: Adapter,
  docs: ReturnType<typeof createDocFeed>,
  /** Absent (the default): no private stream exists, and every document stream is public. */
  privateDocs?: PrivateDocRoute
): Adapter {
  const isDocStream = (schema: string) => parseCollectionSchemaUrn(schema) !== null;
  return {
    namespace: entities.namespace,
    serves: (schema) => isDocStream(schema) || entities.serves(schema),
    snapshot: async (schema, ctx) => {
      if (!isDocStream(schema)) return entities.snapshot(schema, ctx);
      if (privateDocs && (await privateDocs.routes(schema))) {
        return privateDocs.snapshot(schema, ctx);
      }
      return docs.snapshot(schema, ctx);
    },
    changes: (schema, cursor, ctx) => {
      if (!isDocStream(schema)) return entities.changes(schema, cursor, ctx);
      // By the cursor alone: a private cursor never reaches the public feed's state, and a
      // public one never the private feed's, whatever the collection's visibility is now.
      return privateDocs?.issued(cursor)
        ? privateDocs.changes(schema, cursor, ctx)
        : docs.changes(schema, cursor, ctx);
    },
  };
}
