import type { getBounties, getBountyEntries } from '../user-account.service';
import { SUPPORT_ROWS } from '$lib/tickets/support-panels';
import type { HistorySection } from './history';

/** Free-text descriptions are deliberately not carried: the card names the bounty, User Lookup holds the rest. */
export type BountyRow = {
  id: number;
  name: string;
  type: string;
  complete: boolean;
  /** Buzz pledged across all benefactors. */
  pledged: number;
  createdAt: string;
  expiresAt: string;
};

export type BountyEntryRow = {
  id: number;
  bountyId: number;
  bountyName: string;
  createdAt: string;
};

export type TicketBounties =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | {
      status: 'ok';
      userId: number;
      bounties: HistorySection<BountyRow>;
      entries: HistorySection<BountyEntryRow>;
    };

export type BountiesReads = {
  bounties: (userId: number, limit: number) => ReturnType<typeof getBounties>;
  entries: (userId: number, limit: number) => ReturnType<typeof getBountyEntries>;
};

// Imported when read, so loading the ticket detail module opens no database connection.
const liveReads: BountiesReads = {
  bounties: async (userId, limit) =>
    (await import('../user-account.service')).getBounties(userId, limit),
  entries: async (userId, limit) =>
    (await import('../user-account.service')).getBountyEntries(userId, limit),
};

/** One section: a failing read is that section's `unavailable`, never the card's. */
async function section<T>(
  label: string,
  read: () => Promise<{ rows: T[]; truncated: boolean }>
): Promise<HistorySection<T>> {
  try {
    return { status: 'ok', ...(await read()) };
  } catch (e) {
    console.error(`[tickets] bounties ${label} failed`, e);
    return { status: 'unavailable' };
  }
}

/** The bounties the linked user funded and the entries they submitted. The caller has checked the User Lookup grant. */
export async function bountiesSectionFor(
  ticket: { userId: number },
  reads: BountiesReads = liveReads
): Promise<Extract<TicketBounties, { status: 'ok' }>> {
  const { userId } = ticket;
  const [bounties, entries] = await Promise.all([
    section('funded', async () => {
      const { items, truncated } = await reads.bounties(userId, SUPPORT_ROWS);
      return {
        truncated,
        rows: items.map(
          (b): BountyRow => ({
            id: b.id,
            name: b.name,
            type: b.type,
            complete: b.complete,
            pledged: b.unitAmount,
            createdAt: b.createdAt.toISOString(),
            expiresAt: b.expiresAt.toISOString(),
          })
        ),
      };
    }),
    section('entries', async () => {
      const { items, truncated } = await reads.entries(userId, SUPPORT_ROWS);
      return {
        truncated,
        rows: items.map(
          (e): BountyEntryRow => ({
            id: e.id,
            bountyId: e.bountyId,
            bountyName: e.bountyName,
            createdAt: e.createdAt.toISOString(),
          })
        ),
      };
    }),
  ]);
  return { status: 'ok', userId, bounties, entries };
}
