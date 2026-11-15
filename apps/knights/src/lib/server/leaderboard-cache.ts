import { REDIS_TIMEOUT_MS, within } from './redis-timeout';
import type { Board } from './leaderboard';

export type BoardStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds: number) => Promise<void>;
};

/** How long a built board is served before the next request rebuilds it. */
export const BOARD_FRESH_MS = 5 * 60_000;
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);
const keyOf = (now: Date) => `knights:leaderboard:${utcDay(now)}`;

/** A board and when it was built (ms since the epoch). */
export type CachedBoard = Board & { builtAt: number };
const isFresh = (board: CachedBoard, now: Date) =>
  Math.abs(now.getTime() - board.builtAt) < BOARD_FRESH_MS;

function parse(raw: string | null): CachedBoard | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CachedBoard>;
    if (
      Array.isArray(value.rows) &&
      value.badges &&
      typeof value.badges === 'object' &&
      typeof value.builtAt === 'number'
    ) {
      return value as CachedBoard;
    }
  } catch {
    // A value that is not ours is rebuilt.
  }
  return null;
}

/**
 * The board is rebuilt at most once per `BOARD_FRESH_MS`: served from this process's memory, else Redis, else `build`,
 * and each copy is only used while it is fresh and from the same UTC day. Every Redis call is raced against a clock,
 * since an offline client can queue a command and never settle it, and a store that is down serves as if empty.
 * Concurrent callers in one process share one build; two instances may each build once per window.
 */
export function createBoardCache(store: BoardStore, timeoutMs = REDIS_TIMEOUT_MS) {
  let held: { key: string; board: CachedBoard } | undefined;
  const inFlight = new Map<string, Promise<CachedBoard>>();

  async function load(key: string, now: Date, build: () => Promise<Board>): Promise<CachedBoard> {
    let storeUp = true;
    try {
      const cached = parse(await within(store.get(key), timeoutMs));
      if (cached && isFresh(cached, now)) return cached;
    } catch (error) {
      storeUp = false;
      console.error('knights: could not read the cached leaderboard', { error });
    }
    const board: CachedBoard = { ...(await build()), builtAt: now.getTime() };
    if (storeUp) {
      await within(
        store.set(key, JSON.stringify(board), Math.ceil(BOARD_FRESH_MS / 1000)),
        timeoutMs
      ).catch((error) => console.error('knights: could not cache the leaderboard', { error }));
    }
    return board;
  }

  return {
    async get(now: Date, build: () => Promise<Board>): Promise<CachedBoard> {
      const key = keyOf(now);
      if (held?.key === key && isFresh(held.board, now)) return held.board;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = load(key, now, build)
          .then((board) => {
            held = { key, board };
            return board;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
  };
}
