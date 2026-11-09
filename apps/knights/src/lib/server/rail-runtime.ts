import { db } from './db';
import { queryBoard } from './leaderboard';
import { boardCache } from './leaderboard-runtime';
import { createActivityCounter, getRail, votesOnDay } from './rail';

const activity = createActivityCounter((day) => votesOnDay(db, day));

/** The play rail's board position, placed at the player's live fervor, and the Order's activity for today, from the cached board and a short-lived count. */
export const railFor = (userId: number, now: Date, liveFervor?: number) =>
  getRail(
    userId,
    now,
    {
      getBoard: () => boardCache.get(now, () => queryBoard(db, now)),
      activity,
    },
    liveFervor
  );
