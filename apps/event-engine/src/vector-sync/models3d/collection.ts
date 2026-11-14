import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, qdrantClient, type CollectionSpec } from '../qdrant';
import type { Model3DPayload } from './source';

/**
 * The fields the site filters on, plus the two the search service needs for exact-title and
 * quoted-phrase search. name, tags, username, the thumbnail fields and docHash are stored only.
 */
export const MODEL3D_COLLECTION: CollectionSpec<Model3DPayload> = {
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
    ['animated', { type: 'bool', on_disk: true }],
    ['license', { type: 'keyword', on_disk: true }],
    ['publishedAt', { type: 'datetime', on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
  ],
};

export function model3dVectorStore() {
  return new VectorStore<Model3DPayload>(
    qdrantClient(),
    config.vectorSync.model3dCollection,
    MODEL3D_COLLECTION
  );
}
