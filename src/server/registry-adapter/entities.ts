/**
 * Every entity the adapter serves, built from one read of the catalog. Pure: the reads are in
 * `catalog-source.ts`, so this is the whole mapping from platform rows to registry entities.
 */
import type { Audience } from '~/server/registry-adapter/audience';
import { audienceAdmits, isKnownRating } from '~/server/registry-adapter/audience';
import type { Entity } from '~/server/registry-adapter/protocol';
import {
  HEAD_STEP,
  collectionSchemaDocuments,
  deriveCollectionMajors,
  exportedCollections,
} from '~/server/registry-adapter/collection-schema';
import type { ApprovedRelease } from '~/server/registry-adapter/release';
import { ENTITY_SCHEMA_DOCUMENTS } from '~/server/registry-adapter/schemas';
import { sortedKeyJson, releaseBody, sha256Hex } from '~/server/registry-adapter/release';
import {
  APP_RELEASE_SCHEMA,
  APP_SCHEMA,
  LEGACY_SCHEMA_SCHEMA,
  REGISTRY_NAMESPACE,
  ROOT_SCHEMA,
  SCHEMA_STREAMS,
  SERVICE_SCHEMA,
  parseCollectionSchemaUrn,
  registryUrn,
} from '~/server/registry-adapter/urn';
import type { UrnRef } from '~/server/registry-adapter/urn';
import type { AppStorageFeature } from '~/shared/constants/block-storage.constants';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';

export const SERVED_SCHEMAS = [
  ROOT_SCHEMA,
  LEGACY_SCHEMA_SCHEMA,
  APP_SCHEMA,
  APP_RELEASE_SCHEMA,
  SERVICE_SCHEMA,
] as const;

export const RUNTIME_URN = registryUrn({ kind: 'runtime', name: 'iframe', major: 1 });

/** One listed app, as the catalog read found it. */
export type CatalogApp = {
  listing: {
    slug: string;
    kind: 'onsite' | 'offsite';
    name: string;
    tagline: string | null;
    category: string | null;
    contentRating: string | null;
    iconUrl: string | null;
    creatorUsername: string | null;
    externalUrl: string | null;
    sourceRepoUrl: string | null;
    /** The slug of the app this one was forked from, only when that app is in the same catalog. */
    forkOf: string | null;
  };
  /** The backing block of an on-site listing. */
  block: {
    id: string;
    blockId: string;
    version: string;
    status: string;
    contentRating: string;
    manifest: unknown;
  } | null;
  /** Approved publish requests of the block, in review order. */
  approved: Array<{ id: string } & Omit<ApprovedRelease, 'slug'>>;
};

/**
 * The content rating an app entity publishes: the listing's if known ({@link isKnownRating}),
 * else the block's if known, else whichever is set (null if neither), which `audienceAdmits`
 * fails closed on. A shared document has none of its own (`doc-streams.ts`).
 */
export const appContentRating = (app: Pick<CatalogApp, 'listing' | 'block'>): string | null => {
  const listing = app.listing.contentRating;
  const block = app.block?.contentRating ?? null;
  if (isKnownRating(listing)) return listing;
  if (isKnownRating(block)) return block;
  const set = (r: string | null) => (r !== null && r.trim() !== '' ? r : null);
  return set(listing) ?? set(block);
};

export type EntitySets = Map<string, Entity[]>;

/**
 * The entity schemas that carry an app's content, and so its rating, and are narrowed per
 * audience (`audience.ts` describes how). The schema stream is one, under both its names
 * ({@link SCHEMA_STREAMS}): beside the fixed entity schemas it holds every collection schema,
 * whose URN names its app and whose body is that app's declared schema. The one schema left out,
 * `service`, is the runtime record, which belongs to no app.
 */
export const RATED_SCHEMAS: ReadonlySet<string> = new Set([
  APP_SCHEMA,
  APP_RELEASE_SCHEMA,
  ...SCHEMA_STREAMS,
]);

/** The fixed entity schema documents: on the schema stream, and belonging to no app. */
const ENTITY_SCHEMA_URNS: ReadonlySet<string> = new Set(
  ENTITY_SCHEMA_DOCUMENTS.map((doc) => doc.$id as string)
);

const ratingOfBody = (body: unknown): string | null => {
  const rating = (body as { contentRating?: unknown } | null)?.contentRating;
  return typeof rating === 'string' ? rating : null;
};

/**
 * The app URN an entity of `schema` carries the content of: the app itself, a release's `app`,
 * a collection schema's app (by its URN). Null for an entity of no app: a fixed entity schema,
 * which every audience reads, or one this adapter cannot attribute, which none does.
 */
function appUrnOf(schema: string, e: Entity): unknown {
  if (schema === APP_SCHEMA) return e.urn;
  if (schema === APP_RELEASE_SCHEMA) return (e.body as { app?: unknown } | null)?.app;
  const parsed = parseCollectionSchemaUrn(e.urn);
  return parsed ? registryUrn({ kind: 'app', slug: parsed.slug }) : null;
}

/**
 * The entities of `schema` that `audience` may read, from one read of every entity: the narrowing
 * `audience.ts` describes, applied to the catalog. Specific to this function:
 *   - the rating an app, its releases and its collection schemas are admitted by is the
 *     `contentRating` of the app entity's body ({@link appContentRating}, the rating the document
 *     streams narrow by too);
 *   - an entity whose app entity is not in the read has no rating to admit, so it is not sent;
 *   - on the schema stream the fixed entity schemas are sent to everyone;
 *   - an app's `forkOf` names another app: it is dropped from the body sent to an audience that
 *     may not read that app (the entity's `rev` is that body's, so a re-rating of the parent
 *     reaches the fork's subscribers as an upsert with or without it, and an entity whose body
 *     differs per audience has a rev per audience);
 *   - a schema outside {@link RATED_SCHEMAS} is returned whole.
 * Pure; the polling adapter memoizes it per read (`createReadableMemo` in `cursor.ts`).
 */
export function readableBy(sets: EntitySets, schema: string, audience: Audience): Entity[] {
  const all = sets.get(schema) ?? [];
  if (!RATED_SCHEMAS.has(schema)) return all;
  // First wins, as a stream serves a duplicate URN (`cursor.ts`).
  const ratings = new Map<string, string | null>();
  for (const app of sets.get(APP_SCHEMA) ?? []) {
    if (!ratings.has(app.urn)) ratings.set(app.urn, ratingOfBody(app.body));
  }
  const admitted = (appUrn: unknown): boolean =>
    typeof appUrn === 'string' &&
    ratings.has(appUrn) &&
    audienceAdmits(audience, ratings.get(appUrn));
  const readable = all.filter(
    (e) =>
      (SCHEMA_STREAMS.includes(schema) && ENTITY_SCHEMA_URNS.has(e.urn)) ||
      admitted(appUrnOf(schema, e))
  );
  if (schema !== APP_SCHEMA) return readable;
  return readable.map((e) => {
    const { forkOf, ...rest } = (e.body ?? {}) as { forkOf?: unknown } & Record<string, unknown>;
    return forkOf === undefined || admitted(forkOf) ? e : entity(e.urn, APP_SCHEMA, rest);
  });
}

function entity(urn: string, schema: string, body: unknown): Entity {
  const schemas = [schema];
  return { urn, schemas, rev: sha256Hex(sortedKeyJson({ schemas, body })).slice(0, 16), body };
}

export function runtimeEntity(baseUrl: string): Entity {
  return entity(RUNTIME_URN, SERVICE_SCHEMA, {
    name: 'Civitai app runtime',
    kind: 'app-runtime',
    description:
      'Runs Civitai app releases in a sandboxed iframe on civitai.com. Open a release with the launch template; submit an app with the submit page.',
    reads: APP_RELEASE_SCHEMA,
    endpoint: `${baseUrl}/apps`,
    parameters: {
      namespace: REGISTRY_NAMESPACE,
      launch: `${baseUrl}/apps/run/{slug}`,
      submit: `${baseUrl}/apps/submit`,
    },
  });
}

/**
 * The URN, or null when a segment is out of bounds (the store does not bound every name the
 * URN grammar does). One bad row then drops only its own entity, never the whole catalog.
 */
function urnOrSkip(ref: UrnRef, onSkip: (reason: string) => void): string | null {
  try {
    return registryUrn(ref);
  } catch (err) {
    onSkip(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * `features` is the platform's live switch: a collection's schema entities, and its entry in a
 * release's `collections`, are published only while it is exported ({@link exportedCollections},
 * the rule the document streams use). With `registryExport` off, no collection schema is.
 */
export function buildEntities(
  apps: readonly CatalogApp[],
  opts: {
    baseUrl: string;
    onSkip?: (reason: string) => void;
    features?: Readonly<Record<AppStorageFeature, boolean>>;
  }
): EntitySets {
  const onSkip = opts.onSkip ?? (() => undefined);
  const features = opts.features ?? APP_STORAGE_ENABLED_FEATURES;
  const sets: EntitySets = new Map(SERVED_SCHEMAS.map((s) => [s, [] as Entity[]]));
  const add = (schema: string, e: Entity) => sets.get(schema)!.push(e);
  // A schema entity, on the schema stream under each of its names, claiming the name it is served
  // under: a consumer validates an entity against the schema it asked for.
  const addSchema = (urn: string, body: unknown) => {
    for (const stream of SCHEMA_STREAMS) add(stream, entity(urn, stream, body));
  };
  // The schemas the entities below claim, published by this source whatever the catalog holds.
  for (const doc of ENTITY_SCHEMA_DOCUMENTS) addSchema(doc.$id as string, doc);
  add(SERVICE_SCHEMA, runtimeEntity(opts.baseUrl));

  for (const app of apps) {
    const { listing, block } = app;
    const slug = block?.blockId ?? listing.slug;
    // Every other URN of the app embeds its slug, so an app whose own URN cannot be built is
    // skipped whole.
    const appUrn = urnOrSkip({ kind: 'app', slug }, (reason) => onSkip(`app skipped: ${reason}`));
    if (appUrn === null) continue;
    // Releases and schemas are published only while the block itself is approved, as the store
    // requires for storage; the listing alone decides whether the app entity is published.
    const publishable = block !== null && block.status === 'approved';

    const derivation = publishable
      ? deriveCollectionMajors([
          ...app.approved.map((r) => ({ id: r.id, manifest: r.manifest })),
          { id: HEAD_STEP, manifest: block.manifest },
        ])
      : null;

    const exported = publishable
      ? exportedCollections(block.manifest, features)
      : new Set<string>();
    const releases = new Map<string, Entity>();
    if (publishable && derivation) {
      for (const r of app.approved) {
        const skipRelease = (reason: string) =>
          onSkip(`release ${r.id} of ${slug} skipped: ${reason}`);
        const urn = urnOrSkip({ kind: 'release', slug, version: r.version }, skipRelease);
        if (urn === null) continue;
        const collectionUrns = [...(derivation.stepMajors.get(r.id) ?? new Map<string, number>())]
          .filter(([collection]) => exported.has(collection))
          .map(([collection, major]) => [
            collection,
            urnOrSkip({ kind: 'collection-schema', slug, collection, major }, skipRelease),
          ]);
        if (collectionUrns.some(([, u]) => u === null)) continue;
        const collections = Object.fromEntries(collectionUrns);
        // A version approved twice: the later review is the release.
        releases.set(
          urn,
          entity(
            urn,
            APP_RELEASE_SCHEMA,
            releaseBody({
              release: { ...r, slug },
              runtimeUrn: RUNTIME_URN,
              sourceRepoUrl: listing.sourceRepoUrl,
              collections,
            })
          )
        );
      }
      for (const doc of collectionSchemaDocuments(slug, derivation, exported)) {
        addSchema(doc.urn, doc.body);
      }
    }
    for (const e of releases.values()) add(APP_RELEASE_SCHEMA, e);

    // Not logged again: an unbuildable head version was already skipped, and logged, as a release.
    const headUrn = block
      ? urnOrSkip({ kind: 'release', slug, version: block.version }, () => undefined)
      : null;
    const currentRelease = headUrn !== null && releases.has(headUrn) ? headUrn : null;
    const forkOf = listing.forkOf
      ? urnOrSkip({ kind: 'app', slug: listing.forkOf }, (reason) =>
          onSkip(`forkOf of ${slug} dropped: ${reason}`)
        )
      : null;
    add(
      APP_SCHEMA,
      entity(appUrn, APP_SCHEMA, {
        slug,
        name: listing.name,
        kind: listing.kind,
        contentRating: appContentRating(app),
        tagline: listing.tagline,
        category: listing.category,
        iconUrl: listing.iconUrl,
        creator: listing.creatorUsername,
        ...(listing.kind === 'onsite' ? { runtime: RUNTIME_URN } : {}),
        ...(listing.kind === 'offsite' ? { externalUrl: listing.externalUrl } : {}),
        ...(currentRelease ? { release: currentRelease } : {}),
        ...(forkOf ? { forkOf } : {}),
      })
    );
  }
  return sets;
}

/**
 * {@link buildEntities} once per catalog read: while `readApps` returns the same apps (a shared
 * read, `sharedRead` in `cursor.ts`), every call returns the same sets, so the polls of every
 * subscription share one build and one narrowing per audience (`createReadableMemo`). Only the
 * latest build is held.
 */
export function buildEntitiesPerRead(
  readApps: () => Promise<readonly CatalogApp[]>,
  opts: Parameters<typeof buildEntities>[1]
): () => Promise<EntitySets> {
  let last: { apps: readonly CatalogApp[]; sets: EntitySets } | null = null;
  return async () => {
    const apps = await readApps();
    if (last?.apps !== apps) last = { apps, sets: buildEntities(apps, opts) };
    return last.sets;
  };
}
