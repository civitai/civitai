import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { storylineVectorStore } from './collection';
import { getStorylineDocs, type StorylinePayload } from './source';

export const STORYLINE_TOPICS = ['postgres.Storyline', 'postgres.StorylineChapter'];

/**
 * The storyline a CDC message touches. A chapter change names its storyline. A chapter delete
 * carries only its key, the chapter id, so it is resolved through the point's rootChapterId (only
 * chapter 1 is in the document). Edits to chapter 1's post, and bans, change neither table: the
 * refresh walk picks them up.
 */
export function storylineRefFromEvent(topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  if (topic === 'postgres.Storyline') {
    return typeof row.id === 'number' && row.id > 0 ? { id: row.id } : null;
  }
  if (typeof row.storylineId === 'number' && row.storylineId > 0) return { id: row.storylineId };
  return typeof row.id === 'number' && row.id > 0 ? { child: row.id } : null;
}

/** Spec C3: every 15 minutes, 500 storylines. */
export const STORYLINE_REFRESH = { everyMs: 15 * 60_000, batch: 500 };

export const storylineDomain: Domain<StorylinePayload> = {
  name: 'storyline',
  table: 'Storyline',
  getDocs: getStorylineDocs,
  topics: STORYLINE_TOPICS,
  refFromEvent: storylineRefFromEvent,
  cdcTables: ['public.Storyline', 'public.StorylineChapter'],
  childField: 'rootChapterId',
  refresh: STORYLINE_REFRESH,
  store: storylineVectorStore,
  alias: () => config.vectorSync.storylineAlias,
};
