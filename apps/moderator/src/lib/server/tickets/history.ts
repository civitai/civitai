import type { getUserNotes } from '../moderation-memory.service';
import type { getImageRemovals, getModActivity } from '../user-account.service';
import type { getLiveStrikes } from '../user-lookup.service';
import { capped, section, type CardSection } from './section';

/** Rows shown per section; each read asks for one more so a cut is told from a total. */
export const HISTORY_ROWS = 10;
const NOTE_CHARS = 300;

export type HistoryStrike = {
  id: number;
  reason: string;
  status: string;
  points: number;
  createdAt: string;
  expiresAt: string;
  issuedByName: string | null;
  imported: boolean;
};
export type HistoryNote = { id: number; text: string; by: string | null; at: string | null };
export type HistoryActivity = {
  id: number;
  activity: string;
  entityType: string;
  entityId: number | null;
  at: string;
  moderator: string | null;
};
export type HistoryRemoval = {
  key: string;
  type: 'DeleteTOS' | 'Delete' | 'Restore';
  at: string;
  imageId: number;
  actor: string | null;
  reason: string | null;
};

export type TicketHistory =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | {
      status: 'ok';
      userId: number;
      strikes: CardSection<HistoryStrike>;
      notes: CardSection<HistoryNote>;
      activity: CardSection<HistoryActivity>;
      removals: CardSection<HistoryRemoval>;
    };

export type HistoryReads = {
  strikes: (userId: number, limit: number) => ReturnType<typeof getLiveStrikes>;
  notes: (userId: number) => ReturnType<typeof getUserNotes>;
  activity: (userId: number, limit: number) => ReturnType<typeof getModActivity>;
  removals: (
    userId: number,
    limit: number
  ) => Promise<Pick<Awaited<ReturnType<typeof getImageRemovals>>, 'rows' | 'next'>>;
};

// The same reads User Lookup makes, under its grant (`/retool/user-lookup`, the panel's read grant).
// Imported when read, so loading the ticket detail module opens no moderator or ClickHouse connection.
const liveReads: HistoryReads = {
  strikes: async (userId, limit) =>
    (await import('../user-lookup.service')).getLiveStrikes(userId, { limit }),
  notes: async (userId) =>
    (await import('../moderation-memory.service')).getUserNotes(userId, null),
  // The enforcement bucket, as `loadAccountHistory`: crowd ratings would bury every decision.
  activity: async (userId, limit) =>
    (await import('../user-account.service')).getModActivity(userId, limit, 'enforcement'),
  removals: async (userId, limit) =>
    (await import('../user-account.service')).getImageRemovals(userId, undefined, limit),
};

/** No evidence of a CSAM removal is shown in a ticket, however the removal was labelled. */
export const isCsamReason = (...reasons: (string | null)[]) =>
  reasons.some((r) => r && /csam/i.test(r));

type RemovalRow = Awaited<ReturnType<typeof getImageRemovals>>['rows'][number];

/** The removals a ticket may show: CSAM-labelled ones dropped, the rest narrowed to the card's shape. */
export const toVisibleRemovals = (rows: RemovalRow[]): HistoryRemoval[] =>
  rows
    .filter((r) => !isCsamReason(r.tosReason, r.violationType))
    .map(
      (r): HistoryRemoval => ({
        key: r.key,
        type: r.type,
        at: r.at,
        imageId: r.imageId,
        actor: r.actorUsername,
        reason: r.violationType ?? r.tosReason,
      })
    );

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/**
 * The linked user's moderation history, newest first, each section bounded. Read-only: it lists, and
 * User Lookup holds the whole record. A strike's free-text description is not carried.
 */
export async function historySectionFor(
  ticket: { userId: number },
  reads: HistoryReads = liveReads
): Promise<Extract<TicketHistory, { status: 'ok' }>> {
  const { userId } = ticket;
  const [strikes, notes, activity, removals] = await Promise.all([
    section('history', 'strikes', async () =>
      capped(
        await reads.strikes(userId, HISTORY_ROWS + 1),
        HISTORY_ROWS,
        (s): HistoryStrike => ({
          id: s.id,
          reason: s.reason,
          status: s.status,
          points: s.points,
          createdAt: iso(s.createdAt)!,
          expiresAt: iso(s.expiresAt)!,
          issuedByName: s.issuedByName,
          imported: s.imported,
        })
      )
    ),
    section('history', 'notes', async () =>
      capped(
        await reads.notes(userId),
        HISTORY_ROWS,
        (n): HistoryNote => ({
          id: n.id,
          text: (n.notes ?? '').slice(0, NOTE_CHARS),
          by: n.lastUpdateBy,
          at: iso(n.lastUpdate),
        })
      )
    ),
    section('history', 'activity', async () =>
      capped(
        await reads.activity(userId, HISTORY_ROWS + 1),
        HISTORY_ROWS,
        (a): HistoryActivity => ({
          id: a.id,
          activity: a.activity,
          entityType: a.entityType,
          entityId: a.entityId,
          at: iso(a.createdAt)!,
          moderator: a.moderatorUsername,
        })
      )
    ),
    section('history', 'removals', async () => {
      const { rows, next } = await reads.removals(userId, HISTORY_ROWS);
      return {
        rows: toVisibleRemovals(rows),
        truncated: next !== null,
      };
    }),
  ]);
  return { status: 'ok', userId, strikes, notes, activity, removals };
}
