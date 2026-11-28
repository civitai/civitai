/**
 * Every entity the adapter serves, built from one read of the catalog. Pure: the reads are in
 * `catalog-source.ts`, so this is the whole mapping from platform rows to registry entities.
 */
import type { Audience } from '~/server/registry-adapter/audience';
import { audienceAdmits, isKnownRating } from '~/server/registry-adapter/audience';
import type { Entity } from '~/server/registry-adapter/protocol';
import {
  JSON_SCHEMA_DIALECT,
  collectionSchemaDocuments,
  deriveCollectionMajors,
  exportedCollections,
  manifestHistory,
} from '~/server/registry-adapter/collection-schema';
import type { ListingStoreFields } from '~/server/registry-adapter/catalog-source';
import type { ApprovedRelease } from '~/server/registry-adapter/release';
import {
  ENTITY_SCHEMA_DOCUMENTS,
  STORE_LISTING_SCHEMA_DOCUMENT,
} from '~/server/registry-adapter/schemas';
import { sortedKeyJson, releaseBody, sha256Hex } from '~/server/registry-adapter/release';
import {
  APP_RELEASE_SCHEMA,
  APP_SCHEMA,
  STORE_LISTING_SCHEMA,
  REGISTRY_NAMESPACE,
  SERVICE_SCHEMA,
  parseCollectionSchemaUrn,
  registryUrn,
} from '~/server/registry-adapter/urn';
import type { UrnRef } from '~/server/registry-adapter/urn';
import type { AppStorageFeature } from '~/shared/constants/block-storage.constants';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';

/**
 * The schema stream is the root (registry spec, "Schemas"): JSON Schema 2020-12's own meta-schema,
 * {@link JSON_SCHEMA_DIALECT}, the `$schema` every schema body declares. Every schema entity claims
 * it.
 */
export const SERVED_SCHEMAS = [
  JSON_SCHEMA_DIALECT,
  APP_SCHEMA,
  APP_RELEASE_SCHEMA,
  SERVICE_SCHEMA,
] as const;

/** The schemas served: {@link SERVED_SCHEMAS}, plus the listing schema while it is switched on. */
export function servedSchemas({ listings = false }: { listings?: boolean } = {}): string[] {
  return listings ? [...SERVED_SCHEMAS, STORE_LISTING_SCHEMA] : [...SERVED_SCHEMAS];
}

export const RUNTIME_URN = registryUrn({ kind: 'runtime', name: 'iframe', major: 1 });
export const APP_SEARCH_URN = registryUrn({ kind: 'service', name: 'app-search', major: 1 });
export const APP_DATA_URN = registryUrn({ kind: 'service', name: 'app-data', major: 1 });

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
    /** Its store fields, read only while the listing stream is on (`readCatalog`). */
    store?: ListingStoreFields;
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
 * What a document stream's resolver reads of an app (`doc-streams.ts`): its block, its approved
 * releases and its listing's rating. A {@link CatalogApp} is one; so is an app of the
 * document-stream read (`readDocStreamApps`), which carries no other listing field.
 */
export type DocStreamApp = {
  listing: Pick<CatalogApp['listing'], 'contentRating'>;
  block: CatalogApp['block'];
  approved: CatalogApp['approved'];
};

/**
 * The content rating an app entity publishes: the listing's if known ({@link isKnownRating},
 * `xxx` included, so a listing rated `xxx` is published as `xxx` and never as its block's rating),
 * else the block's if known, else whichever is set (null if neither), which `audienceAdmits`
 * fails closed on. A shared document has none of its own (`doc-streams.ts`).
 */
export const appContentRating = (app: Pick<DocStreamApp, 'listing' | 'block'>): string | null => {
  const listing = app.listing.contentRating;
  const block = app.block?.contentRating ?? null;
  if (isKnownRating(listing)) return listing;
  if (isKnownRating(block)) return block;
  const set = (r: string | null) => (r !== null && r.trim() !== '' ? r : null);
  return set(listing) ?? set(block);
};

/**
 * Every entity of one read, by schema. `unavailable` names the schemas whose part of the read
 * failed: a subscription to one ends `unavailable` (`cursor.ts`) rather than read its set as
 * empty, which would send every entity it held as a delete.
 */
export type EntitySets = Map<string, Entity[]> & { unavailable?: ReadonlySet<string> };

/**
 * The entity schemas that carry an app's content, and so its rating, and are narrowed per
 * audience (`audience.ts` describes how). The schema stream ({@link JSON_SCHEMA_DIALECT}) is one:
 * beside the fixed entity schemas it holds every collection schema,
 * whose URN names its app and whose body is that app's declared schema. The one schema left out,
 * `service`, holds the runtime record and the app search and app data services, which belong to
 * no app.
 */
export const RATED_SCHEMAS: ReadonlySet<string> = new Set([
  APP_SCHEMA,
  APP_RELEASE_SCHEMA,
  STORE_LISTING_SCHEMA,
  JSON_SCHEMA_DIALECT,
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
  if (schema === APP_RELEASE_SCHEMA || schema === STORE_LISTING_SCHEMA) {
    return (e.body as { app?: unknown } | null)?.app;
  }
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
 *   - the listing stream, and the listing schema's document on the schema stream, reach only an
 *     audience admitted to listings (`withListings`, `listing-stream.ts`); every other audience
 *     reads them as absent, as it did before they existed;
 *   - a schema outside {@link RATED_SCHEMAS} is returned whole.
 * Pure; the polling adapter memoizes it per read (`createReadableMemo` in `cursor.ts`).
 */
export function readableBy(sets: EntitySets, schema: string, audience: Audience): Entity[] {
  const all = sets.get(schema) ?? [];
  if (!RATED_SCHEMAS.has(schema)) return all;
  if (schema === STORE_LISTING_SCHEMA && !audience.listings) return [];
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
      (schema === JSON_SCHEMA_DIALECT && ENTITY_SCHEMA_URNS.has(e.urn)) ||
      (schema === JSON_SCHEMA_DIALECT &&
        e.urn === STORE_LISTING_SCHEMA &&
        audience.listings === true) ||
      admitted(appUrnOf(schema, e))
  );
  if (schema === STORE_LISTING_SCHEMA) {
    // The body, and so its rev, differ per audience: its media items by their own ratings, and its
    // fork parent's slug, like the app entity's `forkOf`, only for an audience that may read the
    // parent (otherwise it is still a fork, of a parent this audience cannot name).
    const parentAdmitted = (slug: string): boolean => {
      try {
        return admitted(registryUrn({ kind: 'app', slug }));
      } catch {
        return false;
      }
    };
    // Its sub-listings, like its media, by their own ratings: an item whose card rating the
    // audience may not read is left out, and an item image rated above what it may read is dropped
    // from the item (the item stays, as the store shows it with its parent's cover instead).
    const ratingAdmitted = (rating: unknown) =>
      (typeof rating === 'string' || rating === null) && audienceAdmits(audience, rating);
    return readable.map((e) => {
      const body = e.body as {
        media?: Array<{ rating?: unknown }>;
        subListings?: Array<{ cardContentRating?: unknown; image?: { rating?: unknown } | null }>;
        forkOf?: { slug?: unknown } | null;
      } & Record<string, unknown>;
      const media = (body.media ?? []).filter(
        (m) => typeof m.rating === 'string' && audienceAdmits(audience, m.rating)
      );
      const allSubListings = body.subListings ?? [];
      const subListings = allSubListings
        .filter((item) => ratingAdmitted(item.cardContentRating ?? null))
        .map((item) =>
          item.image &&
          !(typeof item.image.rating === 'string' && ratingAdmitted(item.image.rating))
            ? { ...item, image: null }
            : item
        );
      const subListingsNarrowed =
        subListings.length !== allSubListings.length ||
        subListings.some((item, i) => item !== allSubListings[i]);
      const parent = body.forkOf?.slug;
      const hideParent = typeof parent === 'string' && !parentAdmitted(parent);
      if (media.length === (body.media ?? []).length && !subListingsNarrowed && !hideParent) {
        return e;
      }
      return entity(e.urn, STORE_LISTING_SCHEMA, {
        ...body,
        media,
        ...(body.subListings ? { subListings } : {}),
        ...(hideParent ? { forkOf: { slug: null } } : {}),
      });
    });
  }
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
 * The app search service: the app index's `GET {endpoint}?q=&kind=&category=&limit=`, answering
 * over the app entities anyone may read. The text describes what that endpoint does, so a change
 * to its matching, filters or defaults changes this body too.
 */
export function appSearchEntity(endpoint: string): Entity {
  return entity(APP_SEARCH_URN, SERVICE_SCHEMA, {
    name: 'App search',
    kind: 'search',
    description:
      'Finds Civitai apps by name, slug, tagline or creator: every word of q must be a prefix of a word of one of them. SFW apps only. Answers JSON: { results: [{ urn, slug, name, tagline, kind, category, rating, iconUrl, creator }] }, best match first.',
    reads: APP_SCHEMA,
    endpoint,
    parameters: {
      q: "Words to look for; each must start a word of the app's name, slug, tagline or creator. Every app, by name, unless given.",
      kind: 'onsite or offsite. Both unless given.',
      category: 'Only apps of this category.',
      limit: 'How many results at most, 1 to 50. 20 unless given.',
    },
  });
}

/**
 * The app data service: app-data-go's REST surface over the records of an app's declared storage
 * collections, under `{endpoint}/apps/{slug}/...`. Like {@link appSearchEntity}, the text describes
 * what that service does (its routes in `apps/app-data-go/internal/api` and `internal/writes`), so
 * a change to its routes, parameters or auth changes this body too. No `reads`: its records are
 * each of an app's own collection schemas, not one schema's entities.
 */
export function appDataEntity(endpoint: string): Entity {
  return entity(APP_DATA_URN, SERVICE_SCHEMA, {
    name: 'App data',
    kind: 'data',
    description:
      "Reads and writes a Civitai app's stored records: the signed-in viewer's own data, and the app's shared collections, in the storage collections its approved manifest declares. Authorization: Bearer, an App Block token or a Civitai OAuth access token of the app's own OAuth client; an OAuth token's reads also need its AppDataRead scope. There is no separate write scope: the app's storage scope covers writes as well as reads. The site checks every write against the app's approved manifest: declared collections only, and in a shared collection only as its write rule allows (by default each document only by its author, and authoring one needs the viewer's grant of the app's publish scope). Paths are under the endpoint: GET /apps/{slug}/collections/{collection}/records lists records, answering JSON { source, items: [{ key, rev, version, data }] } (a shared collection's list also nextCursor); GET .../records/{key} gets one, as { item }; POST .../records creates one; PUT .../records/{key} writes one; DELETE .../records/{key} deletes one; PUT and DELETE .../records/@me or .../records/@me/{parent} write or delete the viewer's own record of a viewer-keyed collection, and GET reads it in a shared one; GET /apps/{slug}/info answers the viewer's storage usage and limits. A POST or PUT body is a JSON object.",
    endpoint,
    parameters: {
      slug: 'Path: the app whose collection is read or written.',
      collection: "Path: a storage collection declared in the app's manifest.",
      key: 'Path: a record key, 1 to 128 of A-Z a-z 0-9 . _ : -',
      parent: 'Path, @me/{parent} only: 1 to 96 of A-Z a-z 0-9 . _ -',
      major:
        "The collection schema major to read or write. The collection's current major unless given.",
      keyPrefix: 'List only the records whose key starts with this.',
      minSeq:
        'Read only: the highest seq a write of the app answered; the read reflects at least that write, or answers 503 floor_not_met with Retry-After.',
      ifVersion: 'DELETE only: delete only while the record is at this version.',
      limit: "Shared collection's list only: records per page, 1 to 100. 25 unless given.",
      cursor: "Shared collection's list only: the previous page's nextCursor.",
      sort: "Shared collection's list only: key or -key. key unless given.",
      author: "Shared collection's list only: me, for the viewer's own records only.",
    },
  });
}

/**
 * A service endpoint read from the environment variable `variable` (`raw` is its value), to
 * publish: normalized (the URL parser's `href`: surrounding whitespace dropped, host lower-cased),
 * or undefined when it is unset or empty (nothing is published). Anything else must be an absolute
 * `https:` URL with no credentials, query or fragment (a consumer appends its own path or query to
 * the endpoint); otherwise this throws, naming `variable`, so a misconfigured adapter refuses to
 * start rather than advertise an endpoint a browser app cannot call.
 */
export function parseServiceUrl(variable: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${variable} must be an https: URL, got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${variable} must not carry credentials`);
  }
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(url.href)) {
    throw new Error(`${variable} must not carry a query string or fragment`);
  }
  return url.href;
}

/** `REGISTRY_ADAPTER_APP_SEARCH_URL`, the app search endpoint ({@link parseServiceUrl}). */
export const parseAppSearchUrl = (raw: string | undefined): string | undefined =>
  parseServiceUrl('REGISTRY_ADAPTER_APP_SEARCH_URL', raw);

/** `REGISTRY_ADAPTER_APP_DATA_URL`, the app data endpoint ({@link parseServiceUrl}). */
export const parseAppDataUrl = (raw: string | undefined): string | undefined =>
  parseServiceUrl('REGISTRY_ADAPTER_APP_DATA_URL', raw);

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
 *
 * `appSearchUrl` is the public app search endpoint; the app search service entity is published
 * only when it is set ({@link appSearchEntity}). `appDataUrl` likewise, for the app data service
 * ({@link appDataEntity}).
 *
 * `listings` switches the listing stream on: the listing schema's document, and a listing entity
 * for each app entity whose catalog row carries its store fields ({@link listingBody}).
 */
export function buildEntities(
  apps: readonly CatalogApp[] & { listingsFailed?: true },
  opts: {
    baseUrl: string;
    appSearchUrl?: string;
    appDataUrl?: string;
    onSkip?: (reason: string) => void;
    features?: Readonly<Record<AppStorageFeature, boolean>>;
    listings?: boolean;
  }
): EntitySets {
  const onSkip = opts.onSkip ?? (() => undefined);
  const features = opts.features ?? APP_STORAGE_ENABLED_FEATURES;
  const listings = opts.listings === true;
  const sets: EntitySets = new Map(servedSchemas({ listings }).map((s) => [s, [] as Entity[]]));
  // The listing read failed: the listing stream is unavailable, and no listing is built from it.
  const listingsFailed = listings && apps.listingsFailed === true;
  if (listingsFailed) sets.unavailable = new Set([STORE_LISTING_SCHEMA]);
  const add = (schema: string, e: Entity) => sets.get(schema)!.push(e);
  // A schema entity: on the schema stream, claiming the root.
  const addSchema = (urn: string, body: unknown) =>
    add(JSON_SCHEMA_DIALECT, entity(urn, JSON_SCHEMA_DIALECT, body));
  // The schemas the entities below claim, published by this source whatever the catalog holds.
  for (const doc of ENTITY_SCHEMA_DOCUMENTS) addSchema(doc.$id as string, doc);
  if (listings) addSchema(STORE_LISTING_SCHEMA, STORE_LISTING_SCHEMA_DOCUMENT);
  add(SERVICE_SCHEMA, runtimeEntity(opts.baseUrl));
  if (opts.appSearchUrl) add(SERVICE_SCHEMA, appSearchEntity(opts.appSearchUrl));
  if (opts.appDataUrl) add(SERVICE_SCHEMA, appDataEntity(opts.appDataUrl));

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
      ? deriveCollectionMajors(manifestHistory(app.approved, block.manifest))
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
        // The listing's own rating, which the store's database search filters on
        // (`listingMatureFilter`): app-index-go's /search filters on it too, not on the block
        // fallback `contentRating` takes.
        listingContentRating: listing.contentRating,
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

    if (!listings || listingsFailed) continue;
    if (!listing.store) {
      onSkip(`listing of ${slug} skipped: no store fields were read`);
      continue;
    }
    const listingUrn = urnOrSkip({ kind: 'store-listing', slug }, (reason) =>
      onSkip(`listing of ${slug} skipped: ${reason}`)
    );
    if (listingUrn !== null) {
      add(
        STORE_LISTING_SCHEMA,
        entity(listingUrn, STORE_LISTING_SCHEMA, listingBody(app, appUrn, listing.store))
      );
    }
  }
  return sets;
}

/** A store-listing entity's body, as `STORE_LISTING_SCHEMA_DOCUMENT` (`schemas.ts`) describes it. */
export function listingBody(
  app: Pick<CatalogApp, 'listing' | 'block'>,
  appUrn: string,
  store: ListingStoreFields
): Record<string, unknown> {
  const { listing } = app;
  return {
    app: appUrn,
    id: store.id,
    slug: app.block?.blockId ?? listing.slug,
    name: listing.name,
    kind: listing.kind,
    contentRating: appContentRating(app),
    // The listing's own rating: the store gates on the listing column alone (`listingMatureFilter`,
    // `listingMediaCeiling`), never on the block fallback `appContentRating` takes.
    listingContentRating: listing.contentRating,
    tagline: listing.tagline,
    category: listing.category,
    description: store.description,
    iconUrl: listing.iconUrl,
    media: store.media.map((m) => ({ ...m })),
    creator: store.creator
      ? { id: store.creator.id, username: store.creator.username, image: store.creator.image }
      : null,
    isBeta: store.isBeta,
    isOfficial: store.isOfficial,
    ...(listing.kind === 'onsite'
      ? {
          appBlockId: store.appBlockId,
          hasPage: store.hasPage,
          ...(store.liveUrl ? { liveUrl: store.liveUrl } : {}),
        }
      : { externalUrl: listing.externalUrl, connectClientId: store.connectClientId }),
    stats: {
      recommendedCount: store.recommend.recommendedCount,
      notRecommendedCount: store.recommend.notRecommendedCount,
      recommendPct: store.recommend.recommendPct,
      reviewCount: store.reviewCount,
      openCount: listing.kind === 'onsite' ? store.openCount : null,
      installCount: store.installCount,
    },
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
    // The public detail's fields (`ListingDetail`), as an anonymous viewer reads them.
    serialId: store.serialId,
    collaborators: store.collaborators.map((c) => ({
      id: c.id,
      username: c.username,
      image: c.image,
    })),
    sourceRepoUrl: listing.sourceRepoUrl,
    issueTrackerUrl: store.issueTrackerUrl,
    actionsRunSource: store.actionsRunSource
      ? {
          repository: store.actionsRunSource.repository,
          tag: store.actionsRunSource.tag,
          sha: store.actionsRunSource.sha,
        }
      : null,
    scopes: [...store.scopes],
    connectScopes: [...store.connectScopes],
    betaMessage: store.betaMessage,
    forkable: store.forkable,
    forkOf: store.forkOf ? { slug: store.forkOf.slug } : null,
    // The sub-listing cards the store grid shows beside this listing (`ListingSubListingItem`).
    subListings: store.subListings.map((item) => ({
      id: item.id,
      title: item.title,
      tagline: item.tagline,
      contentRating: item.contentRating,
      cardContentRating: item.cardContentRating,
      author: { id: item.author.id, username: item.author.username, image: item.author.image },
      sortTime: item.sortTime,
      runHref: item.runHref,
      external: item.external,
      image: item.image
        ? { url: item.image.url, nsfwLevel: item.image.nsfwLevel, rating: item.image.rating }
        : null,
    })),
    // How many more items the grid shows than `subListings` carries (the cap, `capSubListings`).
    subListingsOmitted: store.subListingsOmitted,
  };
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
