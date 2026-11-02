import { rankIndex } from './ranks';
import { SKIP_STORE_TIMEOUT_MS, within } from './skips';

/** What the player has been shown: the rank and level they were last told about, and whether they dismissed the rating guide. */
export type Seen = { rank: string; level: number; guide: boolean };
export type Standing = { rank: string; level: number };

export type SeenStore = {
  get: (userId: number) => Promise<Seen | null>;
  set: (userId: number, seen: Seen) => Promise<void>;
};

export type ProgressNotice = { kind: 'rank' | 'level'; rank: string; level: number };

type RedisClient = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<unknown>;
};

const keyOf = (userId: number) => `knights:seen:${userId}`;

function parse(raw: string | null): Seen | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Seen>;
    if (
      typeof value.rank === 'string' &&
      Number.isInteger(value.level) &&
      typeof value.guide === 'boolean'
    ) {
      return { rank: value.rank, level: value.level as number, guide: value.guide };
    }
  } catch {
    // A value that is not ours reads as never seen.
  }
  return null;
}

/** No expiry: a lost record only shows the guide and the current rank notice once more. */
export function redisSeenStore(client: () => RedisClient): SeenStore {
  return {
    async get(userId) {
      return parse(await client().get(keyOf(userId)));
    },
    async set(userId, seen) {
      const { rank, level, guide } = seen;
      await client().set(keyOf(userId), JSON.stringify({ rank, level, guide }));
    },
  };
}

/** For tests and the dev environment without Redis. */
export function memorySeenStore(): SeenStore {
  const byPlayer = new Map<number, Seen>();
  return {
    async get(userId) {
      return byPlayer.get(userId) ?? null;
    },
    async set(userId, seen) {
      byPlayer.set(userId, seen);
    },
  };
}

const ahead = (now: Standing, seen: Seen) =>
  rankIndex(now.rank) > rankIndex(seen.rank) ||
  (rankIndex(now.rank) === rankIndex(seen.rank) && now.level > seen.level);

/**
 * The notices the player has not dismissed. The first look records where they stand, so only later progress is announced;
 * a drop (a career reset has its own notice) and the Acolyte to Knight step (the last Trial's reveal says it) are recorded
 * silently. A store that is down shows nothing.
 */
export async function readNotices(
  store: SeenStore,
  userId: number,
  now: Standing,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
): Promise<{ guide: boolean; progress: ProgressNotice | null }> {
  try {
    const seen = await within(store.get(userId), timeoutMs);
    if (!seen) {
      await within(store.set(userId, { ...now, guide: false }), timeoutMs);
      return { guide: true, progress: null };
    }
    const guide = !seen.guide;
    if (!ahead(now, seen)) {
      if (rankIndex(now.rank) < rankIndex(seen.rank) || now.level < seen.level) {
        await within(store.set(userId, { ...now, guide: seen.guide }), timeoutMs);
      }
      return { guide, progress: null };
    }
    if (seen.rank === 'Acolyte' && now.rank === 'Knight') {
      await within(store.set(userId, { ...now, guide: seen.guide }), timeoutMs);
      return { guide, progress: null };
    }
    const kind = now.rank === seen.rank ? 'level' : 'rank';
    return { guide, progress: { kind, rank: now.rank, level: now.level } };
  } catch (error) {
    console.error('knights: could not read what the player has seen', { userId, error });
    return { guide: false, progress: null };
  }
}

async function update(
  store: SeenStore,
  userId: number,
  change: (seen: Seen | null) => Seen,
  timeoutMs: number
): Promise<boolean> {
  try {
    const seen = await within(store.get(userId), timeoutMs);
    await within(store.set(userId, change(seen)), timeoutMs);
    return true;
  } catch (error) {
    console.error('knights: could not store what the player has seen', { userId, error });
    return false;
  }
}

/** False when it could not be stored. */
export const dismissGuide = (
  store: SeenStore,
  userId: number,
  now: Standing,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
) => update(store, userId, (seen) => ({ ...(seen ?? now), guide: true }), timeoutMs);

/** Records the player's current standing as seen. False when it could not be stored. */
export const dismissProgress = (
  store: SeenStore,
  userId: number,
  now: Standing,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
) => update(store, userId, (seen) => ({ ...now, guide: seen?.guide ?? false }), timeoutMs);
