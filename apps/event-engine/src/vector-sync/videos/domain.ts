import { config } from '@/config';
import { videoEmbedUrl } from '../embedder';
import type { Domain, DomainRef } from '../domain/sync';
import { videoVectorStore } from './collection';
import { redisRejectedMemo } from './rejected';
import { getVideoDocs, VIDEO_WHERE, type VideoPayload } from './source';

export const VIDEO_TOPICS = [
  'postgres.Image',
  'postgres.TagsOnImageNew',
  'postgres.ImageResourceNew',
];

/**
 * The video a CDC message touches. An Image change that is not a video is dropped here, since every
 * image upload streams through this topic; a delete carries only the key, so it is always routed.
 * Tag and resource rows carry only imageId and are routed whatever the media type.
 */
export function videoRefFromEvent(topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  if (topic === 'postgres.Image' && event.after && event.after.type !== 'video') return null;
  const id = topic === 'postgres.Image' ? row.id : row.imageId;
  return typeof id === 'number' && id > 0 ? { id } : null;
}

export const videoDomain: Domain<VideoPayload> = {
  name: 'video',
  table: 'Image',
  where: VIDEO_WHERE,
  getDocs: getVideoDocs,
  topics: VIDEO_TOPICS,
  refFromEvent: videoRefFromEvent,
  // A block, review or scan change touches only the Image row.
  cdcTables: ['public.Image', 'public.TagsOnImageNew', 'public.ImageResourceNew'],
  // Held media and owner holds change no Image row; the walk deletes those points.
  refresh: {
    everyMs: config.vectorSync.videoRefreshMinutes * 60_000,
    batch: 500,
    startupDelayMs: 10 * 60_000,
  },
  embedInput: (id, payload) => ({ id: String(id), videoUrl: videoEmbedUrl(payload.url) }),
  rejected: redisRejectedMemo,
  store: videoVectorStore,
  alias: () => config.vectorSync.videoAlias,
};
