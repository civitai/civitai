import { readFile, writeFile } from 'node:fs/promises';
import { config } from '@/config';
import { createEngineCluster } from '@/services/redis-cluster-client';

/** Where a long run keeps its position and pause flag, so a restart or deploy resumes it. */
export interface RunState {
  getCursor(): Promise<number | null>;
  setCursor(id: number): Promise<void>;
  isPaused(): Promise<boolean>;
  setPaused(paused: boolean): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
  /**
   * A lease, so two runs of the same backfill cannot overlap (both would resume from one cursor
   * and pay for every page twice). Each returns whether `owner` holds it afterwards.
   */
  acquireLease(owner: string, ttlMs: number): Promise<boolean>;
  renewLease(owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(owner: string): Promise<void>;
}

// Renew and release only the caller's own lease.
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Redis: survives pod reschedules and is already a dependency of this app. */
export async function redisRunState(name: string): Promise<RunState> {
  const redis = createEngineCluster(new URL(config.redis.url));
  await redis.connect();
  // One hash tag so both keys live on the same cluster slot.
  const key = (k: string) => `vector-sync:{${name}}:${k}`;
  return {
    getCursor: async () => {
      const v = await redis.get(key('cursor'));
      return v === null ? null : Number(v);
    },
    setCursor: async (id) => void (await redis.set(key('cursor'), String(id))),
    isPaused: async () => (await redis.get(key('paused'))) === '1',
    setPaused: async (paused) =>
      void (paused ? await redis.set(key('paused'), '1') : await redis.del(key('paused'))),
    reset: async () => void (await redis.del([key('cursor'), key('paused')])),
    close: async () => void (await redis.quit()),
    acquireLease: async (owner, ttlMs) =>
      (await redis.set(key('lease'), owner, {
        condition: 'NX',
        expiration: { type: 'PX', value: ttlMs },
      })) === 'OK',
    renewLease: async (owner, ttlMs) =>
      Number(
        await redis.eval(RENEW, { keys: [key('lease')], arguments: [owner, String(ttlMs)] })
      ) === 1,
    releaseLease: async (owner) =>
      void (await redis.eval(RELEASE, { keys: [key('lease')], arguments: [owner] })),
  };
}

/** A JSON file, for local runs without Redis. */
export function fileRunState(path: string): RunState {
  type State = { cursor?: number; paused?: boolean; lease?: { owner: string; until: number } };
  const read = async (): Promise<State> =>
    JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
  const write = async (patch: State) =>
    writeFile(path, JSON.stringify({ ...(await read()), ...patch }));
  return {
    getCursor: async () => (await read()).cursor ?? null,
    setCursor: (cursor) => write({ cursor }),
    isPaused: async () => !!(await read()).paused,
    setPaused: (paused) => write({ paused }),
    reset: () => writeFile(path, '{}'),
    close: async () => undefined,
    // Good enough for one machine: read-then-write, not atomic.
    acquireLease: async (owner, ttlMs) => {
      const { lease } = await read();
      if (lease && lease.owner !== owner && lease.until > Date.now()) return false;
      await write({ lease: { owner, until: Date.now() + ttlMs } });
      return true;
    },
    renewLease: async (owner, ttlMs) => {
      const { lease } = await read();
      if (lease?.owner !== owner) return false;
      await write({ lease: { owner, until: Date.now() + ttlMs } });
      return true;
    },
    releaseLease: async (owner) => {
      const state = await read();
      if (state.lease?.owner === owner)
        await writeFile(path, JSON.stringify({ ...state, lease: undefined }));
    },
  };
}
