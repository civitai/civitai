/**
 * INTEGRATION (opt-in): a self-heal forced reconnect always COMPLETES, even with a master down.
 *
 * Run with: REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run cluster-selfheal-bounded
 * Needs docker on Linux. Skipped otherwise.
 *
 * The reconnect is destroy() + connect(), and node-redis's cluster connect() eagerly connects
 * every node in the slot map and awaits them all. With a master unreachable that connect() never
 * settled, so the watchdog's single-flight `reconnecting` flag stayed true and the watchdog never
 * fired again for the life of the process.
 *
 * Driven through the REAL trigger chain, not a direct call: a command to the stopped master's
 * slots is reaped by the (shortened) command deadline, that settle is recorded as a slow-settle
 * hit, and the watchdog's deadline-hit trigger forces the reconnect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __getClusterSelfHealWatchdog, createCacheRedis } from '../client';
import { DockerRedisCluster, dockerAvailable } from './helpers/docker-redis-cluster';

const ENABLED = process.env.REDIS_CLUSTER_IT === '1';
if (ENABLED && !dockerAvailable()) {
  throw new Error('REDIS_CLUSTER_IT=1 but `docker info` failed — docker is required for this test');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// REDIS_CLUSTER_IT_LOG=1 prints the client's own log lines (timestamped) for diagnosis.
const itLog = (msg: string, ...rest: unknown[]) => {
  if (process.env.REDIS_CLUSTER_IT_LOG === '1')
    process.stdout.write(
      `${Date.now()} ${msg} ${rest
        .map((r) => (r instanceof Error ? r.message : String(r)))
        .join(' ')}\n`
    );
};

describe.skipIf(!ENABLED)('cluster self-heal reconnect with a master down', () => {
  const cluster = new DockerRedisCluster('civitai-redis-it-selfheal');
  const key = 'it:down-key';
  let owner = -1;
  let client: any;

  beforeAll(async () => {
    await cluster.start();
    owner = cluster.ownerOf(key);
    // Seed the client with the two masters that stay up. Why: connect() only dials the dead
    // master if ITS discovery is the one that adds it to the slot map. The error-driven
    // rediscovery also re-reads the map every second while a node is failing, and when connect()
    // first spent 5s timing out on the stopped seed, one of those rediscoveries got there first,
    // so connect() completed regardless of its own bound (measured: ~1 run in 3 settled at ~5s
    // with the bound removed). Live seeds make connect() read the map at once — every run then
    // exercises the dead-node dial this test is about.
    const liveSeeds = [0, 1, 2].filter((i) => i !== owner).map((i) => cluster.url(i));
    process.env.REDIS_URL ??= liveSeeds[0];
    process.env.REDIS_SYS_URL ??= liveSeeds[0];
    client = createCacheRedis({
      url: liveSeeds[0],
      cluster: true,
      clusterNodes: liveSeeds.join(','),
      clusterSelfHealEnabled: true,
      clusterSelfHealCheckIntervalMs: 250,
      clusterSelfHealInflightThreshold: 1_000_000,
      clusterSelfHealDeadlineHitThreshold: 1,
      clusterSelfHealDeadlineHitWindowMs: 20_000,
      clusterSelfHealSlowCommandMs: 300,
      clusterSelfHealCooldownMs: 600_000,
      clusterSelfHealReconnectJitterMs: 0,
      clusterCommandTimeoutMs: 1000,
      log: itLog,
    });
    const end = Date.now() + 20_000;
    for (;;) {
      try {
        await client.set('it:warmup', '1');
        break;
      } catch (err) {
        if (Date.now() > end) throw err;
        await sleep(200);
      }
    }
    // The watchdog starts after the initial connect() settles.
    while (!__getClusterSelfHealWatchdog() && Date.now() < end) await sleep(100);
  }, 90_000);

  afterAll(() => {
    try {
      client?.destroy?.();
    } catch {
      // already closed
    }
    cluster.teardown();
    // Teardown is several synchronous docker calls (each bounded at 60s): a slow daemon outlasts
    // vitest's 10s default hook timeout, which failed otherwise-green runs.
  }, 300_000);

  it('the forced reconnect settles and `reconnecting` returns to false within ~12s', async () => {
    const watchdog = __getClusterSelfHealWatchdog();
    expect(watchdog, 'watchdog started').toBeDefined();
    expect(watchdog!.getState().lastReconnectAt).toBeNull();

    cluster.stop(owner);

    // Commands to the stopped master's slots: reaped at the 1s deadline → slow-settle hits.
    const end = Date.now() + 15_000;
    while (watchdog!.getState().lastReconnectAt == null && Date.now() < end) {
      void client.get(key).catch(() => undefined);
      await sleep(250);
    }
    const firedAt = watchdog!.getState().lastReconnectAt;
    // Positive control: the trigger chain fired a reconnect at all.
    expect(firedAt, 'self-heal reconnect fired').not.toBeNull();

    let settledAt: number | null = null;
    const giveUpAt = firedAt! + 30_000;
    while (Date.now() < giveUpAt) {
      if (!watchdog!.getState().reconnecting) {
        settledAt = Date.now();
        break;
      }
      await sleep(100);
    }
    const settleMs = settledAt == null ? Infinity : settledAt - firedAt!;
    process.stdout.write(`[it] selfHealSettleMs=${settleMs}\n`);
    expect(
      settleMs,
      `reconnecting cleared ${settleMs}ms after the reconnect fired`
    ).toBeLessThanOrEqual(12_000);
  }, 90_000);
});
