/**
 * Every entity the adapter serves, built from one read of the catalog. Pure: the reads are in
 * `catalog-source.ts`, so this is the whole mapping from platform rows to registry entities.
 */
import type { Entity } from '~/server/registry-adapter/protocol';
import {
  HEAD_STEP,
  collectionSchemaDocuments,
  deriveCollectionMajors,
} from '~/server/registry-adapter/collection-schema';
import type { ApprovedRelease } from '~/server/registry-adapter/release';
import { sortedKeyJson, releaseBody, sha256Hex } from '~/server/registry-adapter/release';
import {
  APP_RELEASE_SCHEMA,
  APP_SCHEMA,
  REGISTRY_NAMESPACE,
  REGISTRY_SCHEMA_SCHEMA,
  SERVICE_SCHEMA,
  registryUrn,
} from '~/server/registry-adapter/urn';

export const SERVED_SCHEMAS = [
  REGISTRY_SCHEMA_SCHEMA,
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

export type EntitySets = Map<string, Entity[]>;

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

export function buildEntities(apps: readonly CatalogApp[], opts: { baseUrl: string }): EntitySets {
  const sets: EntitySets = new Map(SERVED_SCHEMAS.map((s) => [s, [] as Entity[]]));
  const add = (schema: string, e: Entity) => sets.get(schema)!.push(e);
  add(SERVICE_SCHEMA, runtimeEntity(opts.baseUrl));

  for (const app of apps) {
    const { listing, block } = app;
    const slug = block?.blockId ?? listing.slug;
    // Releases and schemas are published only while the block itself is approved, as the store
    // requires for storage; the listing alone decides whether the app entity is published.
    const publishable = block !== null && block.status === 'approved';

    const derivation = publishable
      ? deriveCollectionMajors([
          ...app.approved.map((r) => ({ id: r.id, manifest: r.manifest })),
          { id: HEAD_STEP, manifest: block.manifest },
        ])
      : null;

    const releases = new Map<string, Entity>();
    if (publishable && derivation) {
      for (const r of app.approved) {
        const urn = registryUrn({ kind: 'release', slug, version: r.version });
        const collections = Object.fromEntries(
          [...(derivation.stepMajors.get(r.id) ?? new Map<string, number>())].map(
            ([collection, major]) => [
              collection,
              registryUrn({ kind: 'collection-schema', slug, collection, major }),
            ]
          )
        );
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
      for (const doc of collectionSchemaDocuments(slug, derivation)) {
        add(REGISTRY_SCHEMA_SCHEMA, entity(doc.urn, REGISTRY_SCHEMA_SCHEMA, doc.body));
      }
    }
    for (const e of releases.values()) add(APP_RELEASE_SCHEMA, e);

    const currentRelease =
      block && releases.has(registryUrn({ kind: 'release', slug, version: block.version }))
        ? registryUrn({ kind: 'release', slug, version: block.version })
        : null;
    add(
      APP_SCHEMA,
      entity(registryUrn({ kind: 'app', slug }), APP_SCHEMA, {
        slug,
        name: listing.name,
        kind: listing.kind,
        contentRating: listing.contentRating ?? block?.contentRating ?? null,
        tagline: listing.tagline,
        category: listing.category,
        iconUrl: listing.iconUrl,
        creator: listing.creatorUsername,
        ...(listing.kind === 'onsite' ? { runtime: RUNTIME_URN } : {}),
        ...(listing.kind === 'offsite' ? { externalUrl: listing.externalUrl } : {}),
        ...(currentRelease ? { release: currentRelease } : {}),
        ...(listing.forkOf ? { forkOf: registryUrn({ kind: 'app', slug: listing.forkOf }) } : {}),
      })
    );
  }
  return sets;
}
