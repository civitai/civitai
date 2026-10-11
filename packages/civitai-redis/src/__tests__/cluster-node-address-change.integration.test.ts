/**
 * INTEGRATION (opt-in): the cluster client follows a master to a NEW address without a restart.
 *
 * Run with: REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run cluster-node-address-change
 * Needs docker on Linux (the test dials the containers' bridge addresses). Skipped otherwise, so
 * CI reports it as skipped rather than running it — see the package README.
 *
 * Scenario: a Redis cluster node changed address after a rolling restart. The node is stopped,
 * re-attached with a new IP and started with the same nodes.conf; the cluster advertises the new
 * address within a second or two. node-redis only re-reads the slot map on MOVED/ASK, which a
 * node that went away never sends, so before the fix the client kept dialling the old address
 * and every command for that master's slots failed until the process restarted.
 *
 * Two outage lengths, because recovery time depends on where the node returns relative to the
 * client's failing connect attempts (each one waits out the 5s connect timeout): back at once,
 * and down for ~4s first.
 *
 * The self-heal watchdog is DISABLED here on purpose: a forced reconnect would also re-read the
 * map, and this test is about the client following the move on its own. The watchdog's own
 * bound is the sibling cluster-selfheal-bounded.integration.test.ts.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCacheRedis } from '../client';
import { DockerRedisCluster, dockerAvailable } from './helpers/docker-redis-cluster';

const ENABLED = process.env.REDIS_CLUSTER_IT === '1';
if (ENABLED && !dockerAvailable()) {
  throw new Error('REDIS_CLUSTER_IT=1 but `docker info` failed — docker is required for this test');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// REDIS_CLUSTER_IT_LOG=1 prints the client's own log lines (timestamped) for diagnosis.
const itLog = (msg: string, ...rest: unknown[]) => {
  if (process.env.REDIS_CLUSTER_IT_LOG !== '1') return;
  const extra = rest.map((r) => (r instanceof Error ? r.message : String(r))).join(' ');
  process.stdout.write(`${Date.now()} ${msg} ${extra}\n`);
};

describe.skipIf(!ENABLED)('cluster client survives a master changing address', () => {
  const cluster = new DockerRedisCluster('civitai-redis-it-move');
  const dials: { host: string; port: number; at: number }[] = [];
  const key = 'it:moved-key';
  let owner = -1;
  let client: any;

  beforeAll(async () => {
    await cluster.start();
    owner = cluster.ownerOf(key);
    // Record every TCP dial node-redis makes (it calls net.createConnection at connect time).
    const real = net.createConnection;
    vi.spyOn(net, 'createConnection').mockImplementation(((...args: any[]) => {
      const o = args[0];
      if (o && typeof o === 'object') dials.push({ host: o.host, port: o.port, at: Date.now() });
      return (real as any).apply(net, args);
    }) as any);

    process.env.REDIS_URL ??= cluster.url(0);
    process.env.REDIS_SYS_URL ??= cluster.url(0);
    client = createCacheRedis({
      url: cluster.url(0),
      cluster: true,
      clusterNodes: [0, 1, 2].map((i) => cluster.url(i)).join(','),
      clusterSelfHealEnabled: false,
      clusterCommandTimeoutMs: 1000,
      clusterSelfHealSlowCommandMs: 500,
      log: itLog,
    });
    // Wait for the client to be usable.
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
  }, 90_000);

  afterAll(async () => {
    try {
      client?.destroy?.();
    } catch {
      // already closed
    }
    vi.restoreAllMocks();
    cluster.teardown();
    // Teardown is several synchronous docker calls (each bounded at 60s): a slow daemon outlasts
    // vitest's 10s default hook timeout, which failed otherwise-green runs.
  }, 300_000);

  it.each([
    { label: 'back at once', newHost: 22, downMs: 0 },
    { label: 'down ~4s first', newHost: 23, downMs: 4000 },
  ])(
    '$label: routes to the new address within ~3s, stops dialling the old one within ~10s',
    async ({ newHost, downMs }) => {
      const oldIp = cluster.ips[owner];
      await client.set(key, 'before');

      // Background traffic for the moving master's slots, as a live app would have.
      let stopTraffic = false;
      const traffic = (async () => {
        while (!stopTraffic) {
          await client.get(key).catch(() => undefined);
          await sleep(100);
        }
      })();

      const moveStartedAt = Date.now();
      const movedBackAt = await cluster.move(owner, cluster.addr(newHost), downMs);

      // (a) First successful command on that master's slots after it is back. A new attempt every
      // 100ms (each bounded by the 1s client deadline); watch for up to 20s so a failure reports
      // the real recovery time rather than just "not within 3s".
      let firstSuccessAt: number | null = null;
      const attempts: Promise<void>[] = [];
      while (firstSuccessAt == null && Date.now() - movedBackAt < 20_000) {
        attempts.push(
          client.set(key, 'after').then(
            () => {
              firstSuccessAt ??= Date.now();
            },
            () => undefined
          )
        );
        await sleep(100);
      }
      await Promise.allSettled(attempts);
      const recoveryMs = firstSuccessAt == null ? Infinity : firstSuccessAt - movedBackAt;

      // (b) Dials to the OLD address from movedBackAt+10s to movedBackAt+16s. The window is wider
      // than the 5s connect timeout, so a client still retrying the old address must show up in it.
      const windowStart = movedBackAt + 10_000;
      const windowEnd = movedBackAt + 16_000;
      const waitMs = windowEnd - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      stopTraffic = true;
      await traffic;

      const oldDials = dials.filter((d) => d.host === oldIp && d.at >= moveStartedAt);
      const lateOldDials = oldDials.filter((d) => d.at >= windowStart && d.at <= windowEnd);
      process.stdout.write(
        `[it] downMs=${downMs} recoveryMs=${recoveryMs} oldAddressDials=${oldDials.length} oldAddressDials10to16s=${lateOldDials.length}\n`
      );

      // Positive control: the client DID dial the old address after the node went away —
      // otherwise a zero below proves nothing about the instrument.
      expect(oldDials.some((d) => d.at < windowStart)).toBe(true);

      // Soft so a failure reports BOTH (a) and (b).
      expect
        .soft(recoveryMs, `first success ${recoveryMs}ms after the move`)
        .toBeLessThanOrEqual(3000);
      expect
        .soft(
          lateOldDials.length,
          `dials to the old address 10-16s after the move: ${lateOldDials.length}`
        )
        .toBe(0);
      await expect(client.get(key)).resolves.toBe('after');
    },
    120_000
  );
});
