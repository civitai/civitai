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

/** Where the player stands on the board and who is beside them, from the cached board. Null when they are not ranked. */
export function railStanding(board: { rows: BoardRow[] }, userId: number): RailStanding | null {
  const index = board.rows.findIndex((row) => row.userId === userId);
  if (index === -1) return null;
  const at = (i: number): Neighbour | null => {
    const row = board.rows[i];
    return row ? { position: i + 1, username: row.username, fervor: row.fervor } : null;
  };
  const above = at(index - 1);
  return {
    position: index + 1,
    total: board.rows.length,
    fervor: board.rows[index].fervor,
    above,
    below: at(index + 1),
    gap: above ? above.fervor - board.rows[index].fervor : null,
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
  }
): Promise<Rail> {
  const [standing, activity] = await Promise.all([
    deps
      .getBoard()
      .then((board) => railStanding(board, userId))
      .catch((error) => {
        console.error('knights: could not read the leaderboard for the rail', { error });
        return null;
      }),
    deps.activity(now),
  ]);
  return { standing, activity };
}
