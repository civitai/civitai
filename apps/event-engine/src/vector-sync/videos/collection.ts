import { config } from '@/config';
import { SITE_REPLICATION, VectorStore, qdrantClient, type CollectionSpec } from '../qdrant';
import type { VideoPayload } from './source';

/** The image collection's filter indexes, on the site instance's replication. */
export const VIDEO_COLLECTION: CollectionSpec<VideoPayload> = {
  ...SITE_REPLICATION,
  quantile: 1.0,
  stampedBy: 'videoProfile',
  indexes: [
    ['nsfwLevel', { type: 'integer', lookup: true, range: true, on_disk: true }],
    ['tagIds', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['baseModels', { type: 'keyword', on_disk: true }],
    ['modelVersionIds', { type: 'integer', lookup: true, range: false, on_disk: true }],
    ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
    ['postId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
    ['sortAt', { type: 'datetime', on_disk: true }],
  ],
};

export function videoVectorStore() {
  return new VectorStore<VideoPayload>(
    qdrantClient(),
    config.vectorSync.videoCollection,
    VIDEO_COLLECTION
  );
}
