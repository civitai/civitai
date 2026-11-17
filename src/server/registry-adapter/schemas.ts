/**
 * The schema documents of the app, release and runtime entities. The adapter brings its own: they
 * are published as schema entities of its namespace beside the collection schemas, and every app,
 * release and runtime entity claims one of them.
 *
 * A schema changes only additively (annotations and new optional properties) within its `@v1`;
 * anything else is a new major.
 */
import { APP_RELEASE_SCHEMA, APP_SCHEMA, SERVICE_SCHEMA } from '~/server/registry-adapter/urn';

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
