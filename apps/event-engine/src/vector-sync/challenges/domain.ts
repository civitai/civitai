import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { challengeVectorStore } from './collection';
import { getChallengeDocs, type ChallengePayload } from './source';

export const CHALLENGE_TOPICS = ['postgres.Challenge', 'postgres.ChallengeEvent'];

/**
 * What a CDC message touches: a challenge row names itself; an event row names every challenge
 * whose point carries its eventId, since the event title is in the document. Cover-image scans
 * change neither table, so a cover's later scan, rating or flag reaches the point only when the
 * challenge next changes: at the latest when it activates or completes, since a user challenge
 * cannot activate unscanned. The site re-checks eligibility on what it shows.
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
