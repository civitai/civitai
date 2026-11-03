import { REDIS_TIMEOUT_MS, within } from './redis-timeout';
import type { Board } from './leaderboard';

export type BoardStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds: number) => Promise<void>;
};

const DAY_SECONDS = 86_400;
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);
const keyOf = (now: Date) => `knights:leaderboard:${utcDay(now)}`;
/** To the end of the UTC day, and a minute past it so the next day's key is the one asked for. */
const ttlOf = (now: Date) =>
  Math.max(60, DAY_SECONDS - Math.floor((now.getTime() % (DAY_SECONDS * 1000)) / 1000) + 60);

function parse(raw: string | null): Board | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Board>;
    if (Array.isArray(value.rows) && value.badges && typeof value.badges === 'object') {
      return value as Board;
    }
  } catch {
    // A value that is not ours is rebuilt.
  }
  return null;
}

/**
 * The board is built once per UTC day: from this process's memory, else Redis, else `build`. Every Redis call is
 * raced against a clock, since an offline client can queue a command and never settle it, and a store that is down
 * serves as if empty. Concurrent callers in one process share one build; two instances may each build once, which is
 * one extra read a day.
 */
export function createBoardCache(store: BoardStore, timeoutMs = REDIS_TIMEOUT_MS) {
  let held: { key: string; board: Board } | undefined;
  const inFlight = new Map<string, Promise<Board>>();

  async function load(key: string, now: Date, build: () => Promise<Board>): Promise<Board> {
    let storeUp = true;
    try {
      const cached = parse(await within(store.get(key), timeoutMs));
      if (cached) return cached;
    } catch (error) {
      storeUp = false;
      console.error('knights: could not read the cached leaderboard', { error });
    }
    const board = await build();
    if (storeUp) {
      await within(store.set(key, JSON.stringify(board), ttlOf(now)), timeoutMs).catch((error) =>
        console.error('knights: could not cache the leaderboard', { error })
      );
    }
    return board;
  }

  return {
    async get(now: Date, build: () => Promise<Board>): Promise<Board> {
      const key = keyOf(now);
      if (held?.key === key) return held.board;
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
