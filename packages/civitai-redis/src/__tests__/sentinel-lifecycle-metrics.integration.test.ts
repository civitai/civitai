/**
 * INTEGRATION (opt-in): civitai_sysredis_sentinel_ready against a real Sentinel.
 *
 * Run with: REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run sentinel-lifecycle
 * Needs docker on Linux; skipped otherwise (see sentinel-master-loss.integration.test.ts).
 *
 * The gauge follows RedisSentinel's own readiness flag, which drops only when the client
 * rediscovers its master. So:
 *   - an IDLE client whose master goes keeps reading 1 until the Sentinel fails over, then reads
 *     0 while it reconfigures and 1 once it is on the new master (first describe — this pins that
 *     limit, so a change in it shows up here rather than on a dashboard);
 *   - a client WITH traffic rediscovers on the failing commands, so it reads 0 during the outage
 *     and 1 again once the master answers, with no failover at all (second describe).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSysRedis } from '../client';
import { dockerAvailable } from './helpers/docker-redis-cluster';
import { DockerRedisSentinel } from './helpers/docker-redis-sentinel';

const ENABLED = process.env.REDIS_CLUSTER_IT === '1';
if (ENABLED && !dockerAvailable()) {
  throw new Error('REDIS_CLUSTER_IT=1 but `docker info` failed — docker is required for this test');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every gauge write, in order: the bridge is a proxy where the ready gauge records. */
type GaugeWrite = { at: number; client: string; value: number };
const gaugeWrites: GaugeWrite[] = [];
const noopMetric = { inc: () => undefined, dec: () => undefined, observe: () => undefined };
(globalThis as any).__civitaiRedisMetrics = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'sysredisSentinelReadyGauge'
        ? {
            labels: (l: Record<string, string>) => ({
              set: (value: number) =>
                void gaugeWrites.push({ at: Date.now(), client: l.client, value }),
            }),
          }
        : prop === 'then'
        ? undefined
        : { ...noopMetric, labels: () => noopMetric },
  }
);

/** The gauge's current value for `client` (its last write). */
const current = (client: string) => gaugeWrites.filter((w) => w.client === client).at(-1)?.value;

async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

function buildSysClient(redis: DockerRedisSentinel): any {
  process.env.REDIS_URL ??= redis.masterUrl;
  process.env.REDIS_SYS_URL ??= redis.masterUrl;
  return createSysRedis({
    sysUrl: redis.masterUrl,
    sysSentinels: redis.sentinelAddress,
    sysSentinelName: redis.masterName,
    sysSelfHealEnabled: false,
    sysCommandTimeoutMs: 2000,
    log: () => undefined,
  });
}

describe.skipIf(!ENABLED)('civitai_sysredis_sentinel_ready across a failover, idle client', () => {
  const DOWN_AFTER_MS = 3000;
  const redis = new DockerRedisSentinel('civitai-redis-it-lifecycle', DOWN_AFTER_MS);
  let client: any;

  beforeAll(async () => {
    await redis.start();
  }, 90_000);

  afterAll(async () => {
    redis.teardown();
  }, 300_000);

  it('reads 0 before the first ready, 1 once connected, 0 on the failover, 1 after it', async () => {
    gaugeWrites.length = 0;
    client = buildSysClient(redis);
    // The first write is the seed at wiring time, before any connect could have completed.
    for (const c of ['serving', 'buffer']) {
      expect(gaugeWrites.find((w) => w.client === c)?.value, `${c} seed`).toBe(0);
    }
    expect(await until(() => current('serving') === 1 && current('buffer') === 1, 20_000)).toBe(
      true
    );
    await client.set('it:lifecycle', 'v');

    const removedAt = Date.now();
    redis.removeMaster();
    const failoverAt = await redis.waitForFailover();
    // Recovered: both clients ready again after the failover, and serving commands.
    expect(
      await until(
        () =>
          gaugeWrites.some((w) => w.client === 'serving' && w.value === 1 && w.at > failoverAt) &&
          current('serving') === 1 &&
          current('buffer') === 1,
        40_000
      ),
      `gauge writes: ${JSON.stringify(gaugeWrites)}`
    ).toBe(true);
    await expect(client.get('it:lifecycle')).resolves.toBe('v');

    // ...in between it read 0 (the reconfigure), for each client — but not before the Sentinel
    // could have failed over: an idle client does not notice its master going.
    const early = gaugeWrites.filter((w) => w.at >= removedAt && w.at < removedAt + DOWN_AFTER_MS);
    expect(early, 'no write before the Sentinel could fail over').toEqual([]);
    for (const c of ['serving', 'buffer']) {
      const drop = gaugeWrites.find((w) => w.client === c && w.value === 0 && w.at >= removedAt);
      expect(
        drop,
        `${c} dropped to 0 after the master went: ${JSON.stringify(gaugeWrites)}`
      ).toBeDefined();
    }
    process.stdout.write(
      `[it] lifecycle failover: ${JSON.stringify(
        gaugeWrites.filter((w) => w.at >= removedAt).map((w) => ({ ...w, at: w.at - removedAt }))
      )}\n`
    );
  }, 180_000);
});

describe.skipIf(!ENABLED)(
  'civitai_sysredis_sentinel_ready when the master returns at its address, client with traffic',
  () => {
    // A down-after far longer than the outage, so the Sentinel never fails over.
    const redis = new DockerRedisSentinel('civitai-redis-it-lifecycle-back', 120_000);

    beforeAll(async () => {
      await redis.start();
    }, 90_000);

    afterAll(async () => {
      redis.teardown();
    }, 300_000);

    it('reads 0 during a 5s outage with no failover and 1 once the master answers', async () => {
      gaugeWrites.length = 0;
      const client = buildSysClient(redis);
      expect(await until(() => current('serving') === 1, 20_000)).toBe(true);
      await client.set('it:lifecycle-back', 'v');

      const stoppedAt = Date.now();
      // Traffic during the outage, so the client does meet the dead master.
      let stop = false;
      let failures = 0;
      const traffic = (async () => {
        while (!stop) {
          await client.get('it:lifecycle-back').catch(() => void (failures += 1));
          await sleep(100);
        }
      })();
      const backAt = await redis.restartMaster(5000);
      expect(await until(() => current('serving') === 1, 20_000)).toBe(true);
      stop = true;
      await traffic;

      const during = gaugeWrites.filter((w) => w.client === 'serving' && w.at >= stoppedAt);
      process.stdout.write(
        `[it] lifecycle restart: failures=${failures} writes=${JSON.stringify(
          during.map((w) => ({ ...w, at: w.at - stoppedAt }))
        )}\n`
      );
      // Positive control: the outage was real — commands failed during it.
      expect(failures).toBeGreaterThan(0);
      expect(redis.currentMaster()).toBe(redis.masterIp); // no failover happened
      const drop = during.find((w) => w.value === 0);
      expect(drop && drop.at < backAt, 'read 0 before the master answered').toBe(true);
      expect(during.some((w) => w.value === 1 && w.at > (drop?.at ?? Infinity))).toBe(true);
    }, 120_000);
  }
);
