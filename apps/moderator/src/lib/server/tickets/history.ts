import type { getUserNotes } from '../moderation-memory.service';
import type { getImageRemovals, getModActivity } from '../user-account.service';
import type { getLiveStrikes } from '../user-lookup.service';

/** Rows shown per section; each read asks for one more so a cut is told from a total. */
export const HISTORY_ROWS = 10;
const NOTE_CHARS = 300;

export type HistorySection<T> =
  | { status: 'ok'; rows: T[]; truncated: boolean }
  | { status: 'unavailable' };

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
      strikes: HistorySection<HistoryStrike>;
      notes: HistorySection<HistoryNote>;
      activity: HistorySection<HistoryActivity>;
      removals: HistorySection<HistoryRemoval>;
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
export const isCsamReason = (...reasons: (string | null)[]) => reasons.some((r) => r && /csam/i.test(r));

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** One section: a failing read is that section's `unavailable`, never the panel's. */
async function section<T>(
  label: string,
  read: () => Promise<{ rows: T[]; truncated: boolean }>
): Promise<HistorySection<T>> {
  try {
    return { status: 'ok', ...(await read()) };
  } catch (e) {
    console.error(`[tickets] history ${label} failed`, e);
    return { status: 'unavailable' };
  }
}

const capped = <T, R>(rows: T[], map: (row: T) => R) => ({
  rows: rows.slice(0, HISTORY_ROWS).map(map),
  truncated: rows.length > HISTORY_ROWS,
});

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
    section('strikes', async () =>
      capped(
        await reads.strikes(userId, HISTORY_ROWS + 1),
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
    section('notes', async () =>
      capped(
        await reads.notes(userId),
        (n): HistoryNote => ({
          id: n.id,
          text: (n.notes ?? '').slice(0, NOTE_CHARS),
          by: n.lastUpdateBy,
          at: iso(n.lastUpdate),
        })
      )
    ),
    section('activity', async () =>
      capped(
        await reads.activity(userId, HISTORY_ROWS + 1),
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
    section('removals', async () => {
      const { rows, next } = await reads.removals(userId, HISTORY_ROWS);
      return {
        rows: rows
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
          ),
        truncated: next !== null,
      };
    }),
  ]);
  return { status: 'ok', userId, strikes, notes, activity, removals };
}
