import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { bountyVectorStore } from './collection';
import { getBountyDocs, type BountyPayload } from './source';

export const BOUNTY_TOPICS = ['postgres.Bounty', 'postgres.TagsOnBounty', 'postgres.BountyEntry'];

/**
 * The bounty a CDC message touches. TagsOnBounty's key includes bountyId, so a tag removal names
 * its bounty; a BountyEntry insert names it through bountyId (hasEntries). An owner ban, a tag
 * rename and an entry delete that carries only its id change no Bounty row: the refresh walk
 * re-syncs every bounty.
 */
export function bountyRefFromEvent(topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  const id = topic === 'postgres.Bounty' ? row.id : row.bountyId;
  return typeof id === 'number' && id > 0 ? { id } : null;
}

export const BOUNTY_REFRESH = { everyMs: 60 * 60_000, batch: 500 };

export const bountyDomain: Domain<BountyPayload> = {
  name: 'bounty',
  table: 'Bounty',
  getDocs: getBountyDocs,
  topics: BOUNTY_TOPICS,
  refFromEvent: bountyRefFromEvent,
  cdcTables: ['public.Bounty', 'public.TagsOnBounty', 'public.BountyEntry'],
  refresh: BOUNTY_REFRESH,
  store: bountyVectorStore,
  alias: () => config.vectorSync.bountyAlias,
};
