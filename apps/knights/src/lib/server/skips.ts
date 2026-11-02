import type { ItemKind, ItemRef } from './feed-token';

/** What a player has passed over: never served to them again, never a vote. Per kind, as the feeds take them. */
export type Skipped = Record<ItemKind, number[]>;

export type SkipStore = {
  add: (userId: number, ref: ItemRef, now: Date) => Promise<void>;
  list: (userId: number) => Promise<ItemRef[]>;
};

const KIND_BYTE: Record<ItemKind, string> = { queue: 'q', hidden: 'h', yesno: 'y' };
const KEEP = 1000;
const TTL_SECONDS = 90 * 24 * 3600;

const memberOf = (ref: ItemRef) => `${KIND_BYTE[ref.kind]}:${ref.id}`;
const refOf = (member: string): ItemRef | null => {
  const [byte, id] = member.split(':');
  const kind = (Object.keys(KIND_BYTE) as ItemKind[]).find((k) => KIND_BYTE[k] === byte);
  return kind && Number.isInteger(Number(id)) ? { kind, id: Number(id) } : null;
};

type EvalClient = {
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
};

// Newest `KEEP` per player, expiring when the player stops skipping.
const ADD = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[3]) + 1))
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`;
const LIST = `return redis.call('ZRANGE', KEYS[1], 0, -1)`;

const keyOf = (userId: number) => `knights:skipped:${userId}`;

export function redisSkipStore(client: () => EvalClient): SkipStore {
  return {
    async add(userId, ref, now) {
      await client().eval(ADD, {
        keys: [keyOf(userId)],
        arguments: [memberOf(ref), String(now.getTime()), String(KEEP), String(TTL_SECONDS)],
      });
    },
    async list(userId) {
      const members = await client().eval(LIST, { keys: [keyOf(userId)], arguments: [] });
      return (Array.isArray(members) ? members : [])
        .map((m) => refOf(String(m)))
        .filter((ref): ref is ItemRef => ref !== null);
    },
  };
}

/** For tests and the dev environment without Redis. */
export function memorySkipStore(): SkipStore {
  const byPlayer = new Map<number, ItemRef[]>();
  return {
    async add(userId, ref) {
      byPlayer.set(userId, [...(byPlayer.get(userId) ?? []), ref]);
    },
    async list(userId) {
      return byPlayer.get(userId) ?? [];
    },
  };
}

/** A Redis client that is offline can queue a command and never settle it, so every call is raced against a clock. */
export const SKIP_STORE_TIMEOUT_MS = 400;

export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`skip store did not answer in ${ms}ms`)), ms);
  });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

/** A store that is down or silent serves as if nothing was skipped: the player sees an item again, nothing is lost. */
export async function skippedFor(
  store: SkipStore,
  userId: number,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
): Promise<Skipped> {
  const skipped: Skipped = { queue: [], hidden: [], yesno: [] };
  try {
    for (const ref of await within(store.list(userId), timeoutMs)) skipped[ref.kind].push(ref.id);
  } catch (error) {
    console.error('knights: could not read the skipped items', { userId, error });
  }
  return skipped;
}

/** False when it could not be remembered; the caller still moves the player on. */
export async function recordSkip(
  store: SkipStore,
  userId: number,
  ref: ItemRef,
  now: Date,
  timeoutMs = SKIP_STORE_TIMEOUT_MS
): Promise<boolean> {
  try {
    await within(store.add(userId, ref, now), timeoutMs);
    return true;
  } catch (error) {
    console.error('knights: could not remember a skipped item', { userId, ref, error });
    return false;
  }
}
