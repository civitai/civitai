/**
 * INTEGRATION (opt-in): a cluster client whose connect() failed is reopened once the cluster is back.
 *
 * Run with: REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run cluster-closed-reopen
 * Needs docker on Linux. Skipped otherwise.
 *
 * Against real node-redis: with every node unreachable the initial connect() fails, RedisCluster
 * resets `isOpen`, and every command throws "The client is closed". Nothing used to reopen it, so it
 * stayed that way for the life of the process after the cluster came back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCacheRedis } from '../client';
import { DockerRedisCluster, dockerAvailable } from './helpers/docker-redis-cluster';

const ENABLED = process.env.REDIS_CLUSTER_IT === '1';
if (ENABLED && !dockerAvailable()) {
  throw new Error('REDIS_CLUSTER_IT=1 but `docker info` failed — docker is required for this test');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  );

describe.skipIf(!ENABLED)('cluster client closed by a failed connect()', () => {
  const cluster = new DockerRedisCluster('civitai-redis-it-closed-reopen');
  let client: any;

  beforeAll(async () => {
    await cluster.start();
  }, 90_000);

  afterAll(() => {
    try {
      client?.destroy?.();
    } catch {
      // already closed
    }
    cluster.teardown();
  }, 300_000);

  it('serves commands again once the cluster is back, without a restart', async () => {
    const seeds = [0, 1, 2].map((i) => cluster.url(i));
    for (const i of [0, 1, 2]) cluster.stop(i);
    process.env.REDIS_URL ??= seeds[0];
    process.env.REDIS_SYS_URL ??= seeds[0];
    client = createCacheRedis({
      url: seeds[0],
      cluster: true,
      clusterNodes: seeds.join(','),
      clusterSelfHealEnabled: false,
    });

    // The production symptom: the failed connect() leaves the client closed.
    let closedError: string | null = null;
    const closedBy = Date.now() + 60_000;
    while (Date.now() < closedBy) {
      if (client.isOpen === false) {
        closedError = await errorOf(client.get('it:k'));
        if (closedError) break;
      }
      await sleep(50);
    }
    expect(closedError).toBe('The client is closed');

    await cluster.restartAll();
    let value: string | null = null;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      try {
        await client.set('it:k', 'v');
        value = await client.get('it:k');
        break;
      } catch {
        await sleep(200);
      }
    }
    expect(value).toBe('v');
    expect(client.isOpen).toBe(true);
  }, 180_000);
});
