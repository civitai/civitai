import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The kill switch, end to end through the real client factory: with
 * REDIS_CLUSTER_BATCHED_GET_ENABLED=false in the environment, `packed.mGet` on the cache cluster
 * must issue only routed per-key GETs and never touch a node connection; unset, it pipelines.
 *
 * `redis` is mocked so no socket is opened: the fake cluster counts routed GETs (`get`) and
 * pipelined ones (`sendCommand` on a node connection) separately.
 */
const h = vi.hoisted(() => ({ clusters: [] as any[] }));

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>();
  const never = () => new Promise<never>(() => undefined);
  return {
    ...actual,
    createCluster: () => {
      const counts = { routed: 0, pipelined: 0 };
      const node = {
        address: 'n1:6379',
        client: {
          sendCommand: async () => {
            counts.pipelined++;
            return null;
          },
        },
      };
      const fake: any = {
        counts,
        slots: Array.from({ length: 16384 }, () => ({ master: node })),
        nodeClient: (m: any) => m.client,
        _slots: {
          masters: [],
          nodeByAddress: new Map(),
          rediscover: vi.fn(() => Promise.resolve()),
        },
        on: () => fake,
        connect: vi.fn(() => Promise.resolve()),
        withTypeMapping: () => fake,
        get: async () => {
          counts.routed++;
          return null;
        },
        _execute: vi.fn(never),
        destroy: vi.fn(),
      };
      h.clusters.push(fake);
      return fake;
    },
  };
});

const KEYS = Array.from({ length: 50 }, (_, i) => `packed:caches:tag-ids-for-images:${i}`);

async function mGetWithEnv(value: string | undefined) {
  // loadRedisEnv is memoized per module instance: load a fresh client module for each env.
  vi.resetModules();
  process.env.REDIS_URL = 'redis://seed-a:6379';
  process.env.REDIS_SYS_URL = 'redis://seed-b:6379';
  if (value === undefined) delete process.env.REDIS_CLUSTER_BATCHED_GET_ENABLED;
  else process.env.REDIS_CLUSTER_BATCHED_GET_ENABLED = value;
  const { createCacheRedis } = await import('../client');
  // No clusterBatchedGetEnabled override: the environment alone decides.
  const client: any = createCacheRedis({
    url: 'redis://seed-a:6379',
    cluster: true,
    clusterNodes: 'redis://seed-a:6379',
    clusterSelfHealEnabled: false,
    log: () => undefined,
  });
  await client.packed.mGet(KEYS);
  return h.clusters.at(-1).counts as { routed: number; pipelined: number };
}

describe('packed.mGet kill switch', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('REDIS_CLUSTER_BATCHED_GET_ENABLED=false: only routed per-key GETs', async () => {
    expect(await mGetWithEnv('false')).toEqual({ routed: KEYS.length, pipelined: 0 });
  });

  it('unset (default on): pipelined, no routed GETs', async () => {
    expect(await mGetWithEnv(undefined)).toEqual({ routed: 0, pipelined: KEYS.length });
  });
});
