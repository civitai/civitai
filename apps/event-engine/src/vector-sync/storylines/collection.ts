import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, type CollectionSpec } from '../qdrant';
import type { StorylinePayload } from './source';

/**
 * The fields the site filters on, the two the search service needs for exact-title and
 * quoted-phrase search, and rootChapterId for chapter deletes. title, username, coverImageId and
 * docHash are stored, never filtered.
 */
export const STORYLINE_COLLECTION: CollectionSpec<StorylinePayload> = {
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
    ['nsfwLevel', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['status', { type: 'keyword', on_disk: true }],
    ['whoCanContinue', { type: 'keyword', on_disk: true }],
    ['rootPublishedAt', { type: 'datetime', on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
    [
      'rootChapterId',
      { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false },
    ],
  ],
};

export function storylineVectorStore() {
  const { qdrantUrl, qdrantApiKey, storylineCollection } = config.vectorSync;
  return new VectorStore<StorylinePayload>(
    new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey }),
    storylineCollection,
    STORYLINE_COLLECTION
  );
}
