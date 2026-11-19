import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, qdrantClient, type CollectionSpec } from '../qdrant';
import type { ModelPayload } from './source';

/**
 * The search service reads these names (contract agreed with it 2026-11-06); exact-title and
 * quoted-phrase search switch on only once the first two show in the collection's payload_schema.
 * name is also word-indexed, for the search service's all-words name match, and tags is a keyword
 * index for the tag match beside it. username, triggerWords and docHash are stored, never filtered;
 * versionIds is only for the live sync's version-delete lookup. A missing index is built on the live collection when the sync starts.
 */
export const MODEL_COLLECTION: CollectionSpec<ModelPayload> = {
  ...SITE_REPLICATION,
  // The demo's measured setting (model-search-demo docs/handoff.md).
  quantile: 0.99,
  indexes: [
    ['title_normalized', { type: 'keyword', on_disk: true, enable_hnsw: false }],
    [
      'search_text',
      {
        type: 'text',
        tokenizer: 'word',
        lowercase: true,
        phrase_matching: true,
        on_disk: true,
        min_token_len: 1,
        max_token_len: 800,
        enable_hnsw: false,
      },
    ],
    [
      'name',
      {
        type: 'text',
        tokenizer: 'word',
        lowercase: true,
        on_disk: true,
        min_token_len: 1,
        max_token_len: 100,
        enable_hnsw: false,
      },
    ],
    ['type', { type: 'keyword', on_disk: true }],
    ['checkpointType', { type: 'keyword', on_disk: true }],
    ['baseModels', { type: 'keyword', on_disk: true }],
    ['tags', { type: 'keyword', on_disk: true, enable_hnsw: false }],
    ['nsfwLevel', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['publishedAt', { type: 'datetime', on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
    [
      'versionIds',
      { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false },
    ],
  ],
};

export function modelVectorStore() {
  return new VectorStore<ModelPayload>(
    qdrantClient(),
    config.vectorSync.modelCollection,
    MODEL_COLLECTION
  );
}
