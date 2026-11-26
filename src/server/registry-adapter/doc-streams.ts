/**
 * Which collection-major streams are served, and from which read:
 *   - the registry EXPORT (`resolveFromCatalog`), from the same catalog read as every other
 *     entity: the app is listed in the public catalog, its block is approved, its enforced
 *     manifest opts the collection in (`registry: "public"`), and the major exists;
 *   - the private, per-viewer and level streams, from the document-stream read
 *     (`readDocStreamApps`): every approved on-site app of an eligible owner, whatever its
 *     listing's visibility or status. Those streams decide access themselves (their gates,
 *     `decide`, the token's claims), so the public listing is not their gate.
 *     {@link docStreamResolvers} wires both.
 */
import type { CatalogApp, DocStreamApp } from '~/server/registry-adapter/entities';
import { appContentRating } from '~/server/registry-adapter/entities';
import {
  collectionSchemaDocuments,
  currentCollectionMajors,
  deriveCollectionMajors,
  exportedCollections,
  manifestHistory,
} from '~/server/registry-adapter/collection-schema';
import type {
  CollectionStream,
  ResolveStream,
  createDocFeed,
} from '~/server/registry-adapter/doc-feed';
import type { ResolveLevelStream, createLevelFeed } from '~/server/registry-adapter/level-feed';
import type { Adapter } from '~/server/registry-adapter/protocol';
import { cursorExpired } from '~/server/registry-adapter/protocol';
import type {
  ResolvePrivateStream,
  createPrivateDocFeed,
} from '~/server/registry-adapter/private-feed';
import {
  parseCollectionSchemaUrn,
  parseViewerSchemaUrn,
  registryUrn,
} from '~/server/registry-adapter/urn';
import type { ResolveViewerStream, createViewerFeed } from '~/server/registry-adapter/viewer-feed';
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

    const majors = collectionFamily({ ...app, block: app.block }, ref);
    if (!majors) return null;
    const docLevels = levels.docLevelsOn ? await levels.docLevelsOn(app.block.id) : false;
    if ((levels.requireDocLevels ?? true) && !docLevels) return null;
    return {
      appId: app.block.id,
      slug: ref.slug,
      collection: ref.collection,
      // The rating the app entity publishes; with content levels on, each document's own rating
      // also applies (`docLevels`).
      contentRating: appContentRating(app),
      ...majors,
      ...(docLevels ? { docLevels: true } : {}),
    };
  };
}

/**
 * The private collection a stream schema names (`private-feed.ts`), from the apps `readApps`
 * gives (the document-stream read, {@link docStreamResolvers}): the app's block is approved, its
 * enforced manifest declares the collection `visibility: "private"`, and the major exists. It
 * decides no access; the private feed's gates do.
 */
export function resolvePrivateFromCatalog(
  readApps: () => Promise<readonly DocStreamApp[]>
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
    const majors = collectionFamily({ ...app, block: app.block }, ref);
    if (!majors) return null;
    return { appId: app.block.id, slug: ref.slug, collection: ref.collection, ...majors };
  };
}

/**
 * The SHARED collection a level stream's schema names (`level-feed.ts`), from the apps
 * `readApps` gives (the document-stream read, {@link docStreamResolvers}): the app's block is
 * approved, its enforced manifest declares the collection `visibility: "shared"` (exported to the
 * registry or not), and the major exists; with the app's content-levels mode (`docLevelsOn`,
 * which fails closed: an unreadable flag counts as on). It decides no access; the level feed's
 * routing does.
 */
export function resolveSharedLevelFromCatalog(
  readApps: () => Promise<readonly DocStreamApp[]>,
  docLevelsOn: (appBlockId: string) => Promise<boolean>
): ResolveLevelStream {
  return async (schema) => {
    const ref = parseCollectionSchemaUrn(schema);
    if (!ref) return null;
    const app = (await readApps()).find(
      (a) => a.block?.blockId === ref.slug && a.block.status === 'approved'
    );
    if (!app?.block) return null;
    const declared = parseManifestStorage(app.block.manifest, APP_STORAGE_ALL_FEATURES_ON);
    const collection = declared.collections.get(ref.collection);
    if (collection?.visibility !== 'shared') return null;
    const majors = collectionFamily({ ...app, block: app.block }, ref);
    if (!majors) return null;
    return {
      appId: app.block.id,
      slug: ref.slug,
      collection: ref.collection,
      contentRating: appContentRating(app),
      ...majors,
      appBlockId: app.block.id,
      levelsOn: await docLevelsOn(app.block.id),
    };
  };
}

/**
 * The SHARED collection a per-viewer stream's URN names (`viewer-feed.ts`), from the apps
 * `readApps` gives (the document-stream read) and by the same rule as
 * {@link resolveSharedLevelFromCatalog}: the app's block is approved, its enforced manifest
 * declares the collection `visibility: "shared"`, and the major exists; with
 * the app's content-levels mode (`docLevelsOn`, which fails closed). It decides no access; the
 * per-viewer stream's gates do.
 */
export function resolveViewerFromCatalog(
  readApps: () => Promise<readonly DocStreamApp[]>,
  docLevelsOn: (appBlockId: string) => Promise<boolean>
): ResolveViewerStream {
  return async (schema) => {
    const ref = parseViewerSchemaUrn(schema);
    if (!ref) return null;
    const app = (await readApps()).find(
      (a) => a.block?.blockId === ref.slug && a.block.status === 'approved'
    );
    if (!app?.block) return null;
    const declared = parseManifestStorage(app.block.manifest, APP_STORAGE_ALL_FEATURES_ON);
    if (declared.collections.get(ref.collection)?.visibility !== 'shared') return null;
    const majors = collectionFamily({ ...app, block: app.block }, ref);
    if (!majors) return null;
    return {
      appId: app.block.id,
      slug: ref.slug,
      collection: ref.collection,
      collectionSchema: registryUrn({ kind: 'collection-schema', ...ref }),
      ...majors,
      levelsOn: await docLevelsOn(app.block.id),
    };
  };
}

/**
 * The adapter's four document-stream resolvers, each on the read it must use: the registry export
 * on the PUBLIC catalog (`readCatalogApps`), so nothing outside it is exported; the private,
 * per-viewer and level streams on the document-stream read (`readDocStreamApps`), so an approved
 * app resolves there whatever its store listing's visibility. The export is gated on content
 * levels (`requireDocLevels`): an app whose levels flag is off exports nothing.
 */
export function docStreamResolvers({
  readCatalogApps,
  readDocStreamApps,
  docLevelsOn,
  features = APP_STORAGE_ENABLED_FEATURES,
}: {
  readCatalogApps: () => Promise<CatalogApp[]>;
  readDocStreamApps: () => Promise<readonly DocStreamApp[]>;
  docLevelsOn: (appBlockId: string) => Promise<boolean>;
  /** The export's live switch ({@link resolveFromCatalog}); the platform's unless given. */
  features?: Readonly<Record<AppStorageFeature, boolean>>;
}): {
  exported: ResolveStream;
  private: ResolvePrivateStream;
  level: ResolveLevelStream;
  viewer: ResolveViewerStream;
} {
  return {
    exported: resolveFromCatalog(readCatalogApps, features, {
      docLevelsOn,
      requireDocLevels: true,
    }),
    private: resolvePrivateFromCatalog(readDocStreamApps),
    level: resolveSharedLevelFromCatalog(readDocStreamApps, docLevelsOn),
    viewer: resolveViewerFromCatalog(readDocStreamApps, docLevelsOn),
  };
}

/**
 * Every major's schema document of `ref.collection`, `@v1` first, and the collection's CURRENT
 * major, both from ONE derivation of the app's approved releases (in review order) then its
 * enforced manifest: {@link manifestHistory} and {@link currentCollectionMajors}, the rule the
 * document store stamps a write's `schema_major` with (`doc-store-schema-major.ts`), never a second
 * copy of it. Null when `ref.major` is not minted.
 */
export function collectionFamily(
  app: DocStreamApp & { block: NonNullable<DocStreamApp['block']> },
  ref: { slug: string; collection: string; major: number }
): Pick<CollectionStream, 'family' | 'currentMajor'> | null {
  const derivation = deriveCollectionMajors(manifestHistory(app.approved, app.block.manifest));
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
  return {
    family: collectionSchemaDocuments(ref.slug, derivation).filter((d) => familyUrns.has(d.urn)),
    currentMajor: currentCollectionMajors(derivation).get(ref.collection),
  };
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

/** The per-viewer streams (`viewer-feed.ts`), when switched on. */
export type ViewerDocRoute = Pick<
  ReturnType<typeof createViewerFeed>,
  'snapshot' | 'changes' | 'routes' | 'issued'
>;

/** The shared-collection level streams (`level-feed.ts`), when switched on. */
export type LevelDocRoute = Pick<
  ReturnType<typeof createLevelFeed>,
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
  privateDocs?: PrivateDocRoute,
  /**
   * Absent (the default): no level stream exists. Present, a level subscription (an allowlisted
   * service client naming a level in `meta`, `level-feed.ts`) is routed there, before anything
   * else; every other subscription is routed as without it.
   */
  levelDocs?: LevelDocRoute,
  /**
   * Absent (the default): no per-viewer stream exists, and a per-viewer URN is not served (`end`,
   * as any schema this source does not serve). Present, every per-viewer URN is routed there, and
   * every cursor it issued resumes there.
   */
  viewerDocs?: ViewerDocRoute
): Adapter {
  const isDocStream = (schema: string) => parseCollectionSchemaUrn(schema) !== null;
  const isViewerStream = (schema: string) => !!viewerDocs?.routes(schema);
  return {
    namespace: entities.namespace,
    serves: (schema) => isDocStream(schema) || isViewerStream(schema) || entities.serves(schema),
    snapshot: async (schema, ctx) => {
      if (viewerDocs && isViewerStream(schema)) return viewerDocs.snapshot(schema, ctx);
      if (!isDocStream(schema)) return entities.snapshot(schema, ctx);
      if (levelDocs?.routes(schema, ctx)) return levelDocs.snapshot(schema, ctx);
      if (privateDocs && (await privateDocs.routes(schema))) {
        return privateDocs.snapshot(schema, ctx);
      }
      return docs.snapshot(schema, ctx);
    },
    changes: (schema, cursor, ctx) => {
      // A per-viewer URN resumes only a per-viewer cursor, and a per-viewer cursor resumes only on
      // a per-viewer URN (its state binds its schema).
      if (viewerDocs && isViewerStream(schema)) {
        return viewerDocs.issued(cursor)
          ? viewerDocs.changes(schema, cursor, ctx)
          : Promise.reject(cursorExpired('the cursor is not a per-viewer stream cursor'));
      }
      if (!isDocStream(schema)) return entities.changes(schema, cursor, ctx);
      // A level cursor resumes only as a level stream (its bindings are checked there); a level
      // subscription resumes no other feed's cursor.
      if (levelDocs?.issued(cursor)) return levelDocs.changes(schema, cursor, ctx);
      if (levelDocs?.routes(schema, ctx)) {
        return Promise.reject(cursorExpired('the cursor is not a level stream cursor'));
      }
      // By the cursor alone: a private cursor never reaches the public feed's state, and a
      // public one never the private feed's, whatever the collection's visibility is now.
      return privateDocs?.issued(cursor)
        ? privateDocs.changes(schema, cursor, ctx)
        : docs.changes(schema, cursor, ctx);
    },
  };
}
