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
  STORE_LISTING_SCHEMA,
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
const chip = {
  type: 'object',
  properties: { id: { type: 'integer' }, username: nullableString, image: nullableString },
};

/**
 * The listing schema. Not one of {@link ENTITY_SCHEMA_DOCUMENTS}: it is published only while the
 * listing stream is switched on, and only to the audiences that may read it (`listing-stream.ts`).
 */
export const STORE_LISTING_SCHEMA_DOCUMENT: Record<string, unknown> = {
  $schema: DIALECT,
  $id: STORE_LISTING_SCHEMA,
  title: "An app's store listing: what a store card and detail page show, with its stats",
  type: 'object',
  required: ['app', 'slug', 'name', 'kind', 'contentRating', 'media', 'stats'],
  properties: {
    app: { type: 'string', description: 'URN of the app entity this listing presents' },
    id: {
      type: 'string',
      description:
        "The listing's id: the store card's key, and the store's tie-break in every sort",
    },
    slug: { type: 'string' },
    name: { type: 'string' },
    kind: { enum: ['onsite', 'offsite'] },
    contentRating: {
      ...nullableString,
      description:
        "The app entity's rating; the listing reaches exactly the audiences the app does",
    },
    listingContentRating: {
      ...nullableString,
      description:
        "The listing's own content rating, without the block fallback `contentRating` has: what the store gates the listing and its media on, and shows on the card. Null when the listing has none",
    },
    tagline: nullableString,
    category: nullableString,
    description: nullableString,
    iconUrl: {
      ...nullableString,
      description: "The app entity's icon, capped at the listing's rating; `media` has the rest",
    },
    media: {
      type: 'array',
      description:
        'Every image the store may show, each with its own rating: a subscription receives the items whose rating its audience admits under the app-rating rule (pg and pg13 for all). Apply the listing-rating ceiling and the host rule per request. `host: red` is a civitai.red override, shown only on a red-capable host, preferred there over the own image of its slot. Order: own icon, own cover, screenshots in order, red icon, red cover',
      items: {
        type: 'object',
        required: ['slot', 'host', 'url', 'nsfwLevel', 'rating'],
        properties: {
          slot: { enum: ['icon', 'cover', 'screenshot'] },
          host: { enum: ['any', 'red'] },
          url: { type: 'string' },
          nsfwLevel: { type: 'integer' },
          rating: { enum: ['pg', 'pg13', 'r', 'x', 'xxx'] },
          caption: { ...nullableString, description: 'Screenshot only' },
          coverUrl: { type: 'string', description: 'Screenshot only: its rendition as a cover' },
        },
      },
    },
    creator: { ...chip, type: ['object', 'null'] },
    isBeta: { type: 'boolean' },
    isOfficial: { type: 'boolean' },
    appBlockId: {
      ...nullableString,
      description: "On-site only: the id of the app's backing block, as the store card carries it",
    },
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
    createdAt: {
      type: 'string',
      format: 'date-time',
      description: "When the listing was created: the store's `newest` sort key",
    },
    updatedAt: { type: ['string', 'null'], format: 'date-time' },
    serialId: {
      type: 'integer',
      description: "The listing's integer id, which its comment thread is keyed on",
    },
    collaborators: {
      type: 'array',
      description: "The app's public byline: accepted collaborators who chose to be shown",
      items: chip,
    },
    sourceRepoUrl: { ...nullableString, description: "The app's public source repository" },
    issueTrackerUrl: { ...nullableString, description: "The app's issue tracker or support link" },
    actionsRunSource: {
      type: ['object', 'null'],
      description:
        'On-site only: the public GitHub Actions run that submitted the serving version. A fact about the run, not about the bundle',
      required: ['repository', 'tag', 'sha'],
      properties: {
        repository: { type: 'string' },
        tag: { type: 'string' },
        sha: { type: 'string' },
      },
    },
    scopes: {
      type: 'array',
      items: { type: 'string' },
      description: "On-site only: the app's approved scope ids. Empty otherwise",
    },
    connectScopes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Off-site only: the account permissions the app is approved to ask for, while it has a connect client. Empty otherwise',
    },
    betaMessage: { ...nullableString, description: "The author's beta note, only while isBeta" },
    forkable: { type: 'boolean', description: 'On-site only: the author lets others fork it' },
    forkOf: {
      type: ['object', 'null'],
      description:
        'Null unless the app is a fork. `slug` names the parent app when this subscription may read it, and is null when the parent is hidden from it or gone: show the parent only if it is visible to the viewer, else that it came from an app that is not available',
      required: ['slug'],
      properties: { slug: nullableString },
    },
  },
};
