import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, qdrantClient, type CollectionSpec } from '../qdrant';
import type { BountyPayload } from './source';

/**
 * The fields the site filters on, plus the two the search service needs for exact-title and
 * quoted-phrase search. name, username and docHash are stored, never filtered.
 */
export const BOUNTY_COLLECTION: CollectionSpec<BountyPayload> = {
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
    ['type', { type: 'keyword', on_disk: true }],
    ['mode', { type: 'keyword', on_disk: true }],
    ['entryMode', { type: 'keyword', on_disk: true }],
    ['baseModel', { type: 'keyword', on_disk: true }],
    ['nsfwLevel', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['startsAt', { type: 'datetime', on_disk: true }],
    ['expiresAt', { type: 'datetime', on_disk: true }],
    ['complete', { type: 'bool', on_disk: true }],
    ['refunded', { type: 'bool', on_disk: true }],
    ['hasEntries', { type: 'bool', on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
  ],
};

export function bountyVectorStore() {
  return new VectorStore<BountyPayload>(
    qdrantClient(),
    config.vectorSync.bountyCollection,
    BOUNTY_COLLECTION
  );
}
