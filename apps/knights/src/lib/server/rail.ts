import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type { Board } from './leaderboard';
import { utcDay } from './leaderboard-cache';

type BoardRow = Pick<Board['rows'][number], 'userId' | 'username' | 'fervor'>;
type Neighbour = { position: number; username: string; fervor: number };

export type RailStanding = {
  position: number;
  total: number;
  fervor: number;
  above: Neighbour | null;
  below: Neighbour | null;
  /** Fervor to gain to overtake `above` (0 on a tie), or null in first place. */
  gap: number | null;
};

/**
 * Where the player stands on the board and who is beside them, from the cached board. Null when they are not ranked.
 * The board is a daily snapshot; pass the player's live `fervor` and their own row and place are read from that, the
 * neighbours staying the cached ones, so the rail never shows a row that disagrees with the big number above it. On a tie
 * the player keeps the side of it the snapshot had them on.
 */
export function railStanding(
  board: { rows: BoardRow[] },
  userId: number,
  liveFervor?: number
): RailStanding | null {
  const index = board.rows.findIndex((row) => row.userId === userId);
  if (index === -1) return null;
  const fervor = liveFervor ?? board.rows[index].fervor;
  const others = board.rows.filter((_, i) => i !== index);
  // `others` keeps the board's order, so everyone ahead of the player is a prefix of it.
  const ahead = others.filter(
    (row, i) => row.fervor > fervor || (row.fervor === fervor && i < index)
  ).length;
  const at = (i: number, position: number): Neighbour | null => {
    const row = others[i];
    return row ? { position, username: row.username, fervor: row.fervor } : null;
  };
  const above = at(ahead - 1, ahead);
  return {
    position: ahead + 1,
    total: board.rows.length,
    fervor,
    above,
    below: at(ahead, ahead + 2),
    gap: above ? above.fervor - fervor : null,
  };
}

/** Everyone's votes on one UTC day, from the per-player day counters. */
export async function votesOnDay(db: Kysely<DB>, day: string): Promise<number> {
  const row = await db
    .selectFrom('KnightsPlayerDay')
    .select(sql<string>`coalesce(sum("votes"), 0)`.as('votes'))
    .where('day', '=', sql<Date>`${day}::date`)
    .executeTakeFirstOrThrow();
  return Number(row.votes);
}

/**
 * Today's judgments across the Order, read at most once per `ttlMs` per process: the counters have no index on the day, and
 * the rail re-reads after every vote. A failed read is null, so the rail leaves the line out.
 */
export function createActivityCounter(
  read: (day: string) => Promise<number>,
  ttlMs = 60_000
): (now: Date) => Promise<number | null> {
  let held: { day: string; at: number; value: number } | undefined;
  return async (now) => {
    const day = utcDay(now);
    if (held && held.day === day && now.getTime() - held.at < ttlMs) return held.value;
    try {
      const value = await read(day);
      held = { day, at: now.getTime(), value };
      return value;
    } catch (error) {
      console.error('knights: could not read the order activity', { error });
      return held?.day === day ? held.value : null;
    }
  };
}

export type Rail = { standing: RailStanding | null; activity: number | null };

/** What the play page's right rail needs beyond the player's own status. Never throws: a missing piece is null. */
export async function getRail(
  userId: number,
  now: Date,
  deps: {
    getBoard: () => Promise<{ rows: BoardRow[] }>;
    activity: (now: Date) => Promise<number | null>;
  },
  liveFervor?: number
): Promise<Rail> {
  const [standing, activity] = await Promise.all([
    deps
      .getBoard()
      .then((board) => railStanding(board, userId, liveFervor))
      .catch((error) => {
        console.error('knights: could not read the leaderboard for the rail', { error });
        return null;
      }),
    deps.activity(now),
  ]);
  return { standing, activity };
}
