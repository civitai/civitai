import { dbRead } from './db';
import { queryBoard } from './leaderboard';
import { boardCache } from './leaderboard-runtime';
import { createActivityCounter, getRail, votesOnDay } from './rail';

// Both reads take the replica. The board is the cache the leaderboard page fills too, so it has one build source; the
// day's vote count is already up to a minute old per process and the page never shows it going down (`neverBelowToday`).
const activity = createActivityCounter((day) => votesOnDay(dbRead, day));

/** The play rail's board position, placed at the player's live fervor, and the Order's activity for today, from the cached board and a short-lived count. */
export const railFor = (userId: number, now: Date, liveFervor?: number) =>
  getRail(
    userId,
    now,
    {
      getBoard: () => boardCache.get(now, () => queryBoard(dbRead, now)),
      activity,
    },
    liveFervor
  );
