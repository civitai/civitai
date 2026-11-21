/**
 * The schema documents of the app, release and runtime entities. The adapter brings its own: they
 * are published as schema entities of its namespace beside the collection schemas, and every app,
 * release and runtime entity claims one of them.
 *
 * A schema changes only additively (annotations and new optional properties) within its `@v1`;
 * anything else is a new major.
 */
import {
  APP_RELEASE_SCHEMA,
  APP_SCHEMA,
  LISTING_SCHEMA,
  SERVICE_SCHEMA,
} from '~/server/registry-adapter/urn';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const nullableString = { type: ['string', 'null'] };

export const ENTITY_SCHEMA_DOCUMENTS: ReadonlyArray<Record<string, unknown>> = [
  {
    $schema: DIALECT,
    $id: APP_SCHEMA,
    title: 'An app listed in an app store',
    type: 'object',
    required: ['slug', 'name', 'kind', 'contentRating'],
    properties: {
      slug: { type: 'string' },
      name: { type: 'string' },
      kind: { enum: ['onsite', 'offsite'] },
      contentRating: {
        ...nullableString,
        description:
          'The content rating of the app, or null when it has none (an off-site app may have no rating). Also the rating of every document this app publishes: a document carries no rating of its own, so a consumer joins it to its app entity.',
      },
      tagline: nullableString,
      category: nullableString,
      iconUrl: nullableString,
      creator: nullableString,
      runtime: { type: 'string', description: 'URN of the runtime record its releases run on' },
      externalUrl: nullableString,
      release: { type: 'string', description: 'URN of the current release' },
      forkOf: {
        type: 'string',
        description: 'URN of the app this one was forked from, when that app is listed too',
      },
    },
  },
  {
    $schema: DIALECT,
    $id: APP_RELEASE_SCHEMA,
    title: 'One released version of an app',
    type: 'object',
    required: ['app', 'version', 'manifest', 'manifestHash', 'runtime'],
    properties: {
      app: { type: 'string' },
      version: { type: 'string' },
      manifest: { type: 'object' },
      manifestHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      runtime: { type: 'string' },
      contentRating: { type: 'string' },
      bundleSha256: { type: 'string' },
      source: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          commit: { type: 'string' },
          claimedCommit: { type: 'string' },
        },
      },
      collections: { type: 'object', additionalProperties: { type: 'string' } },
      releasedAt: { type: 'string', format: 'date-time' },
    },
  },
  {
    $schema: DIALECT,
    $id: SERVICE_SCHEMA,
    title: 'A service that answers questions about entities, found through the registry',
    type: 'object',
    required: ['name', 'kind', 'endpoint'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      kind: { type: 'string', examples: ['search'] },
      reads: { type: 'string', description: 'URN of the schema whose entities it answers about' },
      endpoint: { type: 'string', format: 'uri' },
      parameters: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
];

const count = { type: 'integer', minimum: 0 };

/**
 * The listing schema. Not one of {@link ENTITY_SCHEMA_DOCUMENTS}: it is published only while the
 * listing stream is switched on, and only to the audiences that may read it (`listing-stream.ts`).
 * Detail fields this version does not carry yet (collaborators, scopes, beta message, …) arrive
 * as new optional properties.
 */
export const LISTING_SCHEMA_DOCUMENT: Record<string, unknown> = {
  $schema: DIALECT,
  $id: LISTING_SCHEMA,
  title: "An app's store listing: what a store card and detail page show, with its stats",
  type: 'object',
  required: ['app', 'slug', 'name', 'kind', 'contentRating', 'stats'],
  properties: {
    app: { type: 'string', description: 'URN of the app entity this listing presents' },
    slug: { type: 'string' },
    name: { type: 'string' },
    kind: { enum: ['onsite', 'offsite'] },
    contentRating: {
      ...nullableString,
      description:
        "The app entity's rating; the listing reaches exactly the audiences the app does",
    },
    tagline: nullableString,
    category: nullableString,
    description: nullableString,
    iconUrl: nullableString,
    coverUrl: nullableString,
    screenshots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['url', 'caption'],
        properties: { url: { type: 'string' }, caption: nullableString },
      },
    },
    creator: {
      type: ['object', 'null'],
      properties: { id: { type: 'integer' }, username: nullableString, image: nullableString },
    },
    isBeta: { type: 'boolean' },
    isOfficial: { type: 'boolean' },
    hasPage: { type: 'boolean', description: 'On-site only: the app declares a launch page' },
    liveUrl: { type: 'string', description: "On-site only: the app's standalone origin" },
    externalUrl: { ...nullableString, description: 'Off-site only' },
    stats: {
      type: 'object',
      description: 'Rollups refreshed by a periodic job, so they move at its cadence',
      required: [
        'recommendedCount',
        'notRecommendedCount',
        'recommendPct',
        'reviewCount',
        'openCount',
        'installCount',
      ],
      properties: {
        recommendedCount: count,
        notRecommendedCount: count,
        recommendPct: { type: ['number', 'null'], minimum: 0, maximum: 1 },
        reviewCount: count,
        openCount: { type: ['integer', 'null'], minimum: 0, description: 'null for off-site' },
        installCount: count,
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: ['string', 'null'], format: 'date-time' },
  },
};
