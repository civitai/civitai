import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, type CollectionSpec } from '../qdrant';
import type { CruciblePayload } from './source';

/**
 * The fields the site filters on, plus the two the search service needs for exact-title and
 * quoted-phrase search. name, username, imageId and docHash are stored, never filtered.
 */
export const CRUCIBLE_COLLECTION: CollectionSpec<CruciblePayload> = {
  ...SITE_REPLICATION,
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
    ['status', { type: 'keyword', on_disk: true }],
    ['contentType', { type: 'keyword', on_disk: true }],
    ['nsfwLevel', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['coverNsfwLevel', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['textNsfw', { type: 'bool', on_disk: true }],
    ['buzzType', { type: 'keyword', on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
  ],
};

export function crucibleVectorStore() {
  const { qdrantUrl, qdrantApiKey, crucibleCollection } = config.vectorSync;
  return new VectorStore<CruciblePayload>(
    new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey }),
    crucibleCollection,
    CRUCIBLE_COLLECTION
  );
}
