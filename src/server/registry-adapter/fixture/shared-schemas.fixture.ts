/**
 * DRAFT documents for the shared schemas this adapter's entities claim. They belong to the
 * shared schemas source, not to this adapter; they are here only so a local registry can
 * validate the adapter's entities. `service@v1` is the registry demo's, unchanged.
 */
import type { Entity } from '~/server/registry-adapter/protocol';
import { canonicalJson, sha256Hex } from '~/server/registry-adapter/release';
import {
  APP_RELEASE_SCHEMA,
  APP_SCHEMA,
  REGISTRY_SCHEMA_SCHEMA,
  SERVICE_SCHEMA,
} from '~/server/registry-adapter/urn';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const nullableString = { type: ['string', 'null'] };

export const SHARED_SCHEMA_NAMESPACE = 'civitai-schemas';

export const SHARED_SCHEMA_DOCUMENTS: Record<string, unknown>[] = [
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
      contentRating: nullableString,
      tagline: nullableString,
      category: nullableString,
      iconUrl: nullableString,
      creator: nullableString,
      runtime: { type: 'string', description: 'URN of the runtime record its releases run on' },
      externalUrl: nullableString,
      release: { type: 'string', description: 'URN of the current release' },
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

export function sharedSchemaEntities(): Entity[] {
  return SHARED_SCHEMA_DOCUMENTS.map((body) => ({
    urn: body.$id as string,
    schemas: [REGISTRY_SCHEMA_SCHEMA],
    rev: sha256Hex(canonicalJson(body)).slice(0, 16),
    body,
  }));
}
