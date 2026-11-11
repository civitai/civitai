import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, type CollectionSpec } from '../qdrant';
import type { ArticlePayload } from './source';

/**
 * The fields the site filters on, plus the two the search service needs for exact-title and
 * quoted-phrase search (as for models). title, tags, username, coverImageId, isOfficial and
 * docHash are stored, never filtered.
 */
export const ARTICLE_COLLECTION: CollectionSpec<ArticlePayload> = {
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
    ['tagIds', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['publishedAt', { type: 'datetime', on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
  ],
};

export function articleVectorStore() {
  const { qdrantUrl, qdrantApiKey, articleCollection } = config.vectorSync;
  return new VectorStore<ArticlePayload>(
    new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey }),
    articleCollection,
    ARTICLE_COLLECTION
  );
}
