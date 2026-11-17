import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { comicVectorStore } from './collection';
import { getComicDocs, type ComicPayload } from './source';

export const COMIC_TOPICS = ['postgres.ComicProject', 'postgres.ComicChapter'];

/**
 * The comic a CDC message touches. ComicChapter's key includes projectId, so a chapter delete
 * names its comic. Panel scans, cover flags, owner bans and holds change neither table: panel scans
 * also reach the domain through the site's search.update Outbox rows, and the refresh walk re-syncs
 * every comic for the rest.
 */
export function comicRefFromEvent(topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  const id = topic === 'postgres.ComicProject' ? row.id : row.projectId;
  return typeof id === 'number' && id > 0 ? { id } : null;
}

export const COMIC_REFRESH = { everyMs: 15 * 60_000, batch: 500 };

export const comicDomain: Domain<ComicPayload> = {
  name: 'comic',
  table: 'ComicProject',
  getDocs: getComicDocs,
  topics: COMIC_TOPICS,
  refFromEvent: comicRefFromEvent,
  cdcTables: ['public.ComicProject', 'public.ComicChapter'],
  outboxEntity: 'Comic',
  store: comicVectorStore,
  refresh: COMIC_REFRESH,
  alias: () => config.vectorSync.comicAlias,
};
