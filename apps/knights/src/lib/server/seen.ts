import { rankIndex } from './ranks';
import { REDIS_TIMEOUT_MS, within } from './redis-timeout';
import { LATEST_UPDATE_ID } from './whats-new/entries';

/**
 * What the player has been shown: the rank and level they were last told about, whether they dismissed the rating guide and the
 * launch's "What's new", and whether they accepted the mature content warning in v2 (v1 players arrive without it).
 */
export type Seen = {
  rank: string;
  level: number;
  guide: boolean;
  whatsNew: boolean;
  consent: boolean;
  /**
   * The newest "What's new" entry the player has seen (`whats-new/entries.ts`). Null: none, as on a record from before entries
   * existed, whose player saw the launch and so is shown every entry.
   */
  updatesSeen?: string | null;
};
export type Standing = { rank: string; level: number };

export type SeenStore = {
  get: (userId: number) => Promise<Seen | null>;
  set: (userId: number, seen: Seen) => Promise<void>;
};

/** `fromRank` is the rank the player was last told about, which a rank-up may have skipped past. */
export type ProgressNotice = {
  kind: 'rank' | 'level';
  rank: string;
  level: number;
  from: number;
  fromRank: string;
};

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
      // Records from before "What's new" have no flag: they read as not seen and keep their guide state.
      return {
        rank: value.rank,
        level: value.level as number,
        guide: value.guide,
        whatsNew: value.whatsNew === true,
        consent: value.consent === true,
        updatesSeen: typeof value.updatesSeen === 'string' ? value.updatesSeen : null,
      };
    }
  } catch {
    // A value that is not ours reads as never seen.
  }
  return null;
}

/** No expiry: a lost record only shows "What's new", the guide and the current rank notice once more. */
export function redisSeenStore(client: () => RedisClient): SeenStore {
  return {
    async get(userId) {
      return parse(await client().get(keyOf(userId)));
    },
    async set(userId, seen) {
      const { rank, level, guide, whatsNew, consent, updatesSeen = null } = seen;
      await client().set(
        keyOf(userId),
        JSON.stringify({ rank, level, guide, whatsNew, consent, updatesSeen })
      );
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
 * a drop (a career reset has its own notice) is recorded silently. "What's new" comes first: while it shows, the guide and
 * any progress wait for the next load. A store that is down shows nothing.
 */
export async function readNotices(
  store: SeenStore,
  userId: number,
  now: Standing,
  timeoutMs = REDIS_TIMEOUT_MS
): Promise<{ whatsNew: boolean; guide: boolean; progress: ProgressNotice | null }> {
  try {
    const seen = await within(store.get(userId), timeoutMs);
    if (!seen) {
      await within(
        store.set(userId, {
          ...now,
          guide: false,
          whatsNew: false,
          consent: false,
          updatesSeen: LATEST_UPDATE_ID,
        }),
        timeoutMs
      );
      return { whatsNew: true, guide: false, progress: null };
    }
    if (!ahead(now, seen)) {
      if (rankIndex(now.rank) < rankIndex(seen.rank) || now.level < seen.level) {
        await within(store.set(userId, { ...seen, ...now }), timeoutMs);
      }
      return {
        whatsNew: !seen.whatsNew,
        guide: seen.whatsNew ? !seen.guide : false,
        progress: null,
      };
    }
    if (!seen.whatsNew) return { whatsNew: true, guide: false, progress: null };
    const kind = now.rank === seen.rank ? 'level' : 'rank';
    return {
      whatsNew: false,
      guide: !seen.guide,
      progress: { kind, rank: now.rank, level: now.level, from: seen.level, fromRank: seen.rank },
    };
  } catch (error) {
    console.error('knights: could not read what the player has seen', { userId, error });
    return { whatsNew: false, guide: false, progress: null };
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
  timeoutMs = REDIS_TIMEOUT_MS
) =>
  update(
    store,
    userId,
    (seen) => ({
      ...(seen ?? { ...now, whatsNew: false, consent: false, updatesSeen: LATEST_UPDATE_ID }),
      guide: true,
    }),
    timeoutMs
  );

/** False when it could not be stored. */
export const dismissWhatsNew = (
  store: SeenStore,
  userId: number,
  now: Standing,
  timeoutMs = REDIS_TIMEOUT_MS
) =>
  update(
    store,
    userId,
    (seen) => ({
      ...(seen ?? { ...now, guide: false, consent: false }),
      whatsNew: true,
      updatesSeen: LATEST_UPDATE_ID,
    }),
    timeoutMs
  );

/** Records the player's current standing as seen. False when it could not be stored. */
export const dismissProgress = (
  store: SeenStore,
  userId: number,
  now: Standing,
  timeoutMs = REDIS_TIMEOUT_MS
) =>
  update(
    store,
    userId,
    (seen) => ({
      ...now,
      guide: seen?.guide ?? false,
      whatsNew: seen?.whatsNew ?? false,
      consent: seen?.consent ?? false,
      updatesSeen: seen ? seen.updatesSeen ?? null : LATEST_UPDATE_ID,
    }),
    timeoutMs
  );

/**
 * Whether the player accepted the mature content warning. Null when the store could not be read: the caller lets them play rather
 * than lock every player out while Redis is down, since the warning is asked again on the next read that succeeds.
 */
export async function hasConsented(
  store: SeenStore,
  userId: number,
  timeoutMs = REDIS_TIMEOUT_MS
): Promise<boolean | null> {
  try {
    return (await within(store.get(userId), timeoutMs))?.consent === true;
  } catch (error) {
    console.error('knights: could not read the content warning consent', { userId, error });
    return null;
  }
}

/** Records that the player accepted the mature content warning. False when it could not be stored. */
export const recordConsent = (
  store: SeenStore,
  userId: number,
  now: Standing,
  timeoutMs = REDIS_TIMEOUT_MS
) =>
  update(
    store,
    userId,
    (seen) => ({
      ...(seen ?? { ...now, guide: false, whatsNew: false, updatesSeen: LATEST_UPDATE_ID }),
      consent: true,
    }),
    timeoutMs
  );

/**
 * What the header's "What's new" needs: whether the launch dialog was closed (until then it shows instead), and the newest
 * entry seen. Null with no record yet (the first look on /home or /play makes one, up to date) or when the store cannot be
 * read, which only costs the dot.
 */
export async function readUpdatesSeen(
  store: SeenStore,
  userId: number,
  timeoutMs = REDIS_TIMEOUT_MS
): Promise<{ launchSeen: boolean; updatesSeen: string | null } | null> {
  try {
    const seen = await within(store.get(userId), timeoutMs);
    return seen ? { launchSeen: seen.whatsNew, updatesSeen: seen.updatesSeen ?? null } : null;
  } catch (error) {
    console.error('knights: could not read the seen updates', { userId, error });
    return null;
  }
}

/** Records every entry so far as seen. A player with no record has nothing to record. False when it could not be stored. */
export async function dismissUpdates(
  store: SeenStore,
  userId: number,
  timeoutMs = REDIS_TIMEOUT_MS
): Promise<boolean> {
  try {
    const seen = await within(store.get(userId), timeoutMs);
    if (seen)
      await within(store.set(userId, { ...seen, updatesSeen: LATEST_UPDATE_ID }), timeoutMs);
    return true;
  } catch (error) {
    console.error('knights: could not store the seen updates', { userId, error });
    return false;
  }
}
