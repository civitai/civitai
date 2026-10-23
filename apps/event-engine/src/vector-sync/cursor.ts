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
}

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
  };
}

/** A JSON file, for local runs without Redis. */
export function fileRunState(path: string): RunState {
  type State = { cursor?: number; paused?: boolean };
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
  };
}
