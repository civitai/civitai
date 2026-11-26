import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, qdrantClient, type CollectionSpec } from '../qdrant';
import type { ChallengePayload } from './source';

/**
 * The fields the site filters on, plus the two the search service needs for exact-title and
 * quoted-phrase search. title, theme, username, coverImageId and docHash are stored, never
 * filtered. eventId is also how an event's change finds its challenges.
 */
export const CHALLENGE_COLLECTION: CollectionSpec<ChallengePayload> = {
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
    ['source', { type: 'keyword', on_disk: true }],
    ['buzzType', { type: 'keyword', on_disk: true }],
    ['nsfwLevel', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['coverNsfwLevel', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['modelVersionIds', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['eventId', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['visibleAt', { type: 'datetime', on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
  ],
};

export function challengeVectorStore() {
  return new VectorStore<ChallengePayload>(
    qdrantClient(),
    config.vectorSync.challengeCollection,
    CHALLENGE_COLLECTION
  );
}
