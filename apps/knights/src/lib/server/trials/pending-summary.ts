import { SKIP_STORE_TIMEOUT_MS, within } from '../skips';

/** The run whose passed summary a new Knight has not yet moved past; 0 once they have. Absent for everyone else. */
export type SummaryStore = {
  get: (userId: number) => Promise<number | null>;
  set: (userId: number, runId: number) => Promise<void>;
};

type RedisClient = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<unknown>;
};

const keyOf = (userId: number) => `knights:trial-summary:${userId}`;

export function redisSummaryStore(client: () => RedisClient): SummaryStore {
  return {
    async get(userId) {
      const value = Number(await client().get(keyOf(userId)));
      return Number.isInteger(value) && value > 0 ? value : null;
    },
    async set(userId, runId) {
      await client().set(keyOf(userId), String(runId));
    },
  };
}

/** For tests and the dev environment without Redis. */
export function memorySummaryStore(): SummaryStore {
  const byPlayer = new Map<number, number>();
  return {
    async get(userId) {
      return byPlayer.get(userId) || null;
    },
    async set(userId, runId) {
      byPlayer.set(userId, runId);
    },
  };
}

/**
 * Remembers that a passed run's summary is still to be shown. Without it a reload after the last answer would drop a
 * new Knight straight into the queue; only a pass needs it, since a failed run's summary lasts as long as its cooldown.
 * A store that is down skips the summary rather than holding the player back.
 */
export async function markPassedSummary(
  store: SummaryStore,
  userId: number,
  runId: number,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
): Promise<void> {
  try {
    await within(store.set(userId, runId), timeoutMs);
  } catch (error) {
    console.error('knights: could not remember the passed Trials summary', { userId, error });
  }
}

export async function pendingPassedSummary(
  store: SummaryStore,
  userId: number,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
): Promise<number | null> {
  try {
    return await within(store.get(userId), timeoutMs);
  } catch (error) {
    console.error('knights: could not read the passed Trials summary', { userId, error });
    return null;
  }
}

/** False when it could not be stored. */
export async function acknowledgePassedSummary(
  store: SummaryStore,
  userId: number,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
): Promise<boolean> {
  try {
    await within(store.set(userId, 0), timeoutMs);
    return true;
  } catch (error) {
    console.error('knights: could not store the Trials summary acknowledgement', { userId, error });
    return false;
  }
}
