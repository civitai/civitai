import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { collectionVectorStore } from './collection';
import { getCollectionDocs, type CollectionPayload } from './source';

export const COLLECTION_TOPICS = ['postgres.Collection'];

/**
 * The collection a CDC message touches. A delete is hard and cascades to its items. Its first
 * item, its last item leaving, an owner ban and a cover change no Collection row: the refresh walk
 * re-syncs every collection. CollectionItem is not routed here, since it is the busiest table the
 * connector streams and bookmark adds would re-read a collection per item.
 */
export function collectionRefFromEvent(_topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  return row && typeof row.id === 'number' && row.id > 0 ? { id: row.id } : null;
}

export const COLLECTION_REFRESH = { everyMs: 6 * 60 * 60_000, batch: 500 };

export const collectionDomain: Domain<CollectionPayload> = {
  name: 'collection',
  table: 'Collection',
  getDocs: getCollectionDocs,
  topics: COLLECTION_TOPICS,
  refFromEvent: collectionRefFromEvent,
  cdcTables: ['public.Collection'],
  refresh: COLLECTION_REFRESH,
  store: collectionVectorStore,
  alias: () => config.vectorSync.collectionAlias,
};
