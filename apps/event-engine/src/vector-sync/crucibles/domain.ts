import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { crucibleVectorStore } from './collection';
import { getCrucibleDocs, type CruciblePayload } from './source';

export const CRUCIBLE_TOPICS = ['postgres.Crucible'];

/**
 * The crucible a CDC message touches. A takedown is an update; a cover's later scan or rating
 * changes no crucible row, so it reaches the point only when the crucible next changes: the site
 * re-checks eligibility on what it shows.
 */
export function crucibleRefFromEvent(_topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  return row && typeof row.id === 'number' && row.id > 0 ? { id: row.id } : null;
}

export const crucibleDomain: Domain<CruciblePayload> = {
  name: 'crucible',
  table: 'Crucible',
  getDocs: getCrucibleDocs,
  topics: CRUCIBLE_TOPICS,
  refFromEvent: crucibleRefFromEvent,
  cdcTables: ['public.Crucible'],
  store: crucibleVectorStore,
  alias: () => config.vectorSync.crucibleAlias,
};
