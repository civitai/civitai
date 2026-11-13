import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { challengeVectorStore } from './collection';
import { getChallengeDocs, type ChallengePayload } from './source';

export const CHALLENGE_TOPICS = ['postgres.Challenge', 'postgres.ChallengeEvent'];

/**
 * What a CDC message touches: a challenge row names itself; an event row names every challenge
 * whose point carries its eventId, since the event title is in the document. A change to the
 * cover image alone (its scan, rating or flag) changes neither table, so the point keeps its old
 * eligibility and coverNsfwLevel until the challenge next changes or a backfill re-reads it,
 * which for a finished challenge may be never. The site must hydrate every hit through the
 * feed's own query and never trust the payload.
 */
export function challengeRefFromEvent(topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row || typeof row.id !== 'number' || row.id <= 0) return null;
  return topic === 'postgres.ChallengeEvent' ? { child: row.id } : { id: row.id };
}

export const challengeDomain: Domain<ChallengePayload> = {
  name: 'challenge',
  table: 'Challenge',
  getDocs: getChallengeDocs,
  topics: CHALLENGE_TOPICS,
  refFromEvent: challengeRefFromEvent,
  cdcTables: ['public.Challenge', 'public.ChallengeEvent'],
  childField: 'eventId',
  store: challengeVectorStore,
  alias: () => config.vectorSync.challengeAlias,
};
