/**
 * INTEGRATION (opt-in): the sys (Sentinel) client follows a failover after its master is gone
 * for good, without a restart.
 *
 * Run with: REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run sentinel-master-loss
 * Needs docker on Linux (the test dials the containers' bridge addresses). Skipped otherwise, so
 * CI reports it as skipped rather than running it — see the package README.
 *
 * Scenario: the master is stopped and never comes back at its address (a rescheduled master gets
 * a new one). For at least `down-after-milliseconds` the Sentinel still names the old master, and
 * a discovery in that window opens master connections to the old address. node-redis 5.x
 * (@redis/client 5.8.3, sentinel/index.js `transform`) awaits those connects, and every command,
 * every later discovery (the `switch-master` notification included) and `destroy()` waits on that
 * discovery. With a reconnect strategy that never gives up, the connect to the dead address never
 * settles, so the client keeps timing out after the Sentinel has promoted the replica, until the
 * process restarts. Two ways in: a running client whose master goes away, and a client that
 * starts while the Sentinel still names a master that is gone. @redis/client 6.2.0+ rejects such
 * a connect on its first error (`#connectOrFail`), so the discovery starts over and finds the new
 * master; these two describes are red on 5.8.3 and green on 6.3.0, with no local guard.
 *
 * The last describe is the other side of that change: because 6.x gives up on the FIRST error, a
 * master that comes back at the SAME address (a restart, no failover) must still be found again
 * once it answers. 5.8.3 recovers there too, so this guards the upgrade against regressing it; it
 * does not reproduce the bug.
 *
 * Production connect timeout (REDIS_TIMEOUT default, 5s). The self-heal watchdog is DISABLED on
 * purpose: these tests are about the client following the master on its own.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSysRedis } from '../client';
import { dockerAvailable } from './helpers/docker-redis-cluster';
import { DockerRedisSentinel } from './helpers/docker-redis-sentinel';

const ENABLED = process.env.REDIS_CLUSTER_IT === '1';
if (ENABLED && !dockerAvailable()) {
  throw new Error('REDIS_CLUSTER_IT=1 but `docker info` failed — docker is required for this test');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every civitai_sysredis_sentinel_client_errors_total increment, by label set: the metrics bridge
 * is a proxy where that counter records and everything else is a no-op.
 */
const sentinelClientErrors: Record<string, string>[] = [];
const noopMetric = { inc: () => undefined, dec: () => undefined, observe: () => undefined };
(globalThis as any).__civitaiRedisMetrics = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'sysredisSentinelClientErrorsCounter'
        ? {
            labels: (l: Record<string, string>) => ({
              inc: () => void sentinelClientErrors.push(l),
            }),
          }
        : prop === 'then'
        ? undefined
        : { ...noopMetric, labels: () => noopMetric },
  }
);

/** The client's own log lines, timestamped (REDIS_CLUSTER_IT_LOG=1 also prints them). */
type LogLine = { at: number; msg: string };
function recordingLog(lines: LogLine[]) {
  return (msg: string, ...rest: unknown[]) => {
    lines.push({ at: Date.now(), msg });
    if (process.env.REDIS_CLUSTER_IT_LOG !== '1') return;
    const extra = rest.map((r) => (r instanceof Error ? r.message : String(r))).join(' ');
    process.stdout.write(`${Date.now()} ${msg} ${extra}\n`);
  };
}
/** The line the sys reconnect strategy logs on each retry it schedules (client.ts socketConfig). */
const RECONNECT = 'Redis reconnecting, retry ';
/** The line RedisSentinel's discovery produces when it opens master connections to `ip`. */
const masterChangeTo = (ip: string) =>
  `Redis sentinel topology change [type=MASTER_CHANGE, host=${ip}, port=6379]`;

/** Build the sys client through the package factory. */
function buildSysClient(
  redis: DockerRedisSentinel,
  lines: LogLine[],
  extra: Record<string, unknown> = {}
): any {
  process.env.REDIS_URL ??= redis.masterUrl;
  process.env.REDIS_SYS_URL ??= redis.masterUrl;
  return createSysRedis({
    sysUrl: redis.masterUrl,
    sysSentinels: redis.sentinelAddress,
    sysSentinelName: redis.masterName,
    sysSelfHealEnabled: false,
    // Short, so a parked command reports as a failure inside the polling loops below.
    sysCommandTimeoutMs: 2000,
    log: recordingLog(lines),
    ...extra,
  });
}

async function untilServing(client: any, key: string): Promise<void> {
  const end = Date.now() + 20_000;
  for (;;) {
    try {
      await client.set(key, 'before');
      return;
    } catch (err) {
      if (Date.now() > end) throw err;
      await sleep(200);
    }
  }
}

/** Record every TCP dial node-redis makes (it calls net.createConnection at connect time). */
function recordDials(dials: { host: string; port: number; at: number }[]): void {
  const real = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation(((...args: any[]) => {
    const o = args[0];
    if (o && typeof o === 'object') dials.push({ host: o.host, port: o.port, at: Date.now() });
    return (real as any).apply(net, args);
  }) as any);
}

/** Background traffic, as a live app would have. Returns a stop function that awaits the loop. */
function startTraffic(client: any, key: string): () => Promise<void> {
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await client.get(key).catch(() => undefined);
      await sleep(100);
    }
  })();
  return async () => {
    stop = true;
    await loop;
  };
}

/**
 * Time from `since` to the first successful `op()`, issuing a new attempt every 100ms (each
 * bounded by the 2s command timeout) for up to `watchMs`; Infinity if none succeeded.
 */
async function firstSuccessAfter(
  op: () => Promise<unknown>,
  since: number,
  watchMs: number
): Promise<{ at: number | null; ms: number }> {
  let at: number | null = null;
  const attempts: Promise<void>[] = [];
  while (at == null && Date.now() - since < watchMs) {
    attempts.push(
      op().then(
        () => {
          at ??= Date.now();
        },
        () => undefined
      )
    );
    await sleep(100);
  }
  await Promise.allSettled(attempts);
  return { at, ms: at == null ? Infinity : at - since };
}

// Recovery bound after the failover: about a second for the Sentinel poll to see it, the next
// failed connect to the old address (up to the 5s connect timeout plus the 3s backoff cap), then
// RedisSentinel's 1s wait and a connect to the new master. About 10s; the bound leaves margin.
const RECOVERY_BOUND_MS = 20_000;

describe.skipIf(!ENABLED)('sys Sentinel client survives losing its master for good', () => {
  const redis = new DockerRedisSentinel('civitai-redis-it-sentinel', 3000);
  const dials: { host: string; port: number; at: number }[] = [];
  const lines: LogLine[] = [];
  const key = 'it:sentinel-key';
  let client: any;

  beforeAll(async () => {
    await redis.start();
    recordDials(dials);
    client = buildSysClient(redis, lines);
    await untilServing(client, key);
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    redis.teardown();
    // Teardown is several synchronous docker calls (each bounded at 60s): a slow daemon outlasts
    // vitest's 10s default hook timeout.
  }, 300_000);

  it('serves commands again soon after the failover and stops dialling the old master', async () => {
    const oldMaster = redis.masterIp;
    expect(redis.currentMaster()).toBe(oldMaster);

    // The first command after the master closes its connections starts the discovery while the
    // Sentinel still names the old master.
    const stopTraffic = startTraffic(client, key);
    const removedAt = Date.now();
    redis.removeMaster();
    const failoverAt = await redis.waitForFailover();

    // (a) First successful command after the failover; watched for 40s so a failure reports the
    // real recovery time.
    const { at: firstSuccessAt, ms: recoveryMs } = await firstSuccessAfter(
      () => client.get(key),
      failoverAt,
      40_000
    );

    // (b) Dials to the old master in a 10s window starting 2s after the first success (or after
    // the 40s watch). Wider than one 5s connect timeout plus the 3s backoff cap, so a client still
    // retrying the old address must show up in it.
    const windowStart = (firstSuccessAt ?? Date.now()) + 2000;
    const windowEnd = windowStart + 10_000;
    const waitMs = windowEnd - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    await stopTraffic();

    const lateOldDials = dials.filter(
      (d) => d.host === oldMaster && d.at >= windowStart && d.at <= windowEnd
    );
    process.stdout.write(
      `[it] failoverAfterMs=${failoverAt - removedAt} recoveryMs=${recoveryMs} oldMasterDialsLate=${
        lateOldDials.length
      }\n`
    );

    // Positive control: the discovery DID open master connections to the old address after it
    // went away (the stale-master path this test is about). Without it, a green below could mean
    // the client rediscovered only after the failover and never met the hazard.
    expect(
      lines.some(
        (l) => l.msg === masterChangeTo(oldMaster) && l.at >= removedAt && l.at < failoverAt
      )
    ).toBe(true);
    // Instrument check for (b): the dial recorder saw the dials to the old address.
    expect(dials.some((d) => d.host === oldMaster && d.at >= removedAt)).toBe(true);
    // The master connections' errors reached civitai_sysredis_sentinel_client_errors_total
    // (RedisSentinel forwards them as `error` with passthroughClientErrorEvents; it never
    // re-emits `client-error`), labelled with the master they belong to.
    expect(
      sentinelClientErrors.filter((l) => l.type === 'MASTER' && l.host === oldMaster).length,
      `sentinel client-error counter increments: ${JSON.stringify(sentinelClientErrors)}`
    ).toBeGreaterThan(0);

    // Soft so a failure reports BOTH (a) and (b).
    expect
      .soft(recoveryMs, `first success ${recoveryMs}ms after the failover`)
      .toBeLessThanOrEqual(RECOVERY_BOUND_MS);
    expect
      .soft(lateOldDials.length, `dials to the old master after recovery: ${lateOldDials.length}`)
      .toBe(0);
    await expect(client.get(key)).resolves.toBe('before');
  }, 180_000);
});

describe.skipIf(!ENABLED)('sys Sentinel client that starts while its master is gone', () => {
  // A wider failover window than above: the client must be built and run its first discovery
  // before the Sentinel promotes the replica, and on a loaded box the docker calls that remove the
  // master can take seconds (the positive control below reports a run that missed it).
  const redis = new DockerRedisSentinel('civitai-redis-it-sentinel-start', 8000);
  const lines: LogLine[] = [];
  const key = 'it:sentinel-start-key';

  beforeAll(async () => {
    await redis.start();
  }, 90_000);

  afterAll(async () => {
    redis.teardown();
  }, 300_000);

  it('serves commands soon after the failover', async () => {
    const oldMaster = redis.masterIp;
    const removedAt = Date.now();
    redis.removeMaster();
    // Built while the Sentinel still names the old master.
    const client = buildSysClient(redis, lines);
    const failoverAt = await redis.waitForFailover();
    const { ms: recoveryMs } = await firstSuccessAfter(
      () => client.set(key, 'after'),
      failoverAt,
      40_000
    );
    process.stdout.write(
      `[it] start: failoverAfterMs=${failoverAt - removedAt} recoveryMs=${recoveryMs}\n`
    );

    // Positive control: its first discovery chose the old master.
    expect(lines.some((l) => l.msg === masterChangeTo(oldMaster) && l.at < failoverAt)).toBe(true);
    expect(recoveryMs, `first write ${recoveryMs}ms after the failover`).toBeLessThanOrEqual(
      RECOVERY_BOUND_MS
    );
    await expect(client.get(key)).resolves.toBe('after');
  }, 180_000);
});

describe.skipIf(!ENABLED)(
  'sys Sentinel client reconnects to a master that returns at its address',
  () => {
    // A down-after far longer than the outage, so the Sentinel never fails over: the master stays
    // the master and comes back where it was (a process restart, not a reschedule).
    const redis = new DockerRedisSentinel('civitai-redis-it-sentinel-back', 120_000);
    const lines: LogLine[] = [];
    const key = 'it:sentinel-back-key';
    let client: any;

    beforeAll(async () => {
      await redis.start();
      client = buildSysClient(redis, lines);
      await untilServing(client, key);
    }, 90_000);

    afterAll(async () => {
      redis.teardown();
    }, 300_000);

    it.each([{ downMs: 1000 }, { downMs: 12_000 }])(
      'down $downMs ms: serves commands again within 5s of the master answering',
      async ({ downMs }) => {
        const stopTraffic = startTraffic(client, key);
        const stoppedAt = Date.now();
        const backAt = await redis.restartMaster(downMs);
        // A write: the master restarted empty, and a write proves the connection is to the master.
        const { ms: recoveryMs } = await firstSuccessAfter(
          () => client.set(key, `after-${downMs}`),
          backAt,
          30_000
        );
        await stopTraffic();
        const reconnects = lines.filter(
          (l) => l.at >= stoppedAt && l.msg.startsWith(RECONNECT)
        ).length;
        // Rediscoveries that re-opened master connections to the same address: the churn 6.x's
        // give-up-on-first-error can cause during a restart. Reported, not asserted.
        const reopened = lines.filter(
          (l) => l.at >= stoppedAt && l.msg === masterChangeTo(redis.masterIp)
        ).length;
        process.stdout.write(
          `[it] restart downMs=${downMs} recoveryMs=${recoveryMs} reconnects=${reconnects} reopened=${reopened}\n`
        );
        expect(redis.currentMaster()).toBe(redis.masterIp); // no failover happened
        expect(
          recoveryMs,
          `first write ${recoveryMs}ms after the master answered`
        ).toBeLessThanOrEqual(5000);
        await expect(client.get(key)).resolves.toBe(`after-${downMs}`);
        // Positive control: the master really went away under this client (its reconnect strategy
        // ran), so the recovery above is a recovery and not a client that never noticed.
        expect(reconnects).toBeGreaterThan(0);
      },
      120_000
    );
  }
);

describe.skipIf(!ENABLED)(
  'sys Sentinel client whose connect() gives up while its master is down at the same address',
  () => {
    // node-redis 6 rejects a master connect on its first error, so a connect() that overlaps an
    // outage with no failover gives up after its rediscovery passes (maxCommandRediscovers, about
    // a second apart) and RedisSentinel destroys the client. connectSysClient retries it; without
    // that the client stays closed for good. A down-after far longer than the outage: no failover.
    const redis = new DockerRedisSentinel('civitai-redis-it-sentinel-giveup', 300_000);
    const lines: LogLine[] = [];
    const key = 'it:sentinel-giveup-key';

    beforeAll(async () => {
      await redis.start();
    }, 90_000);

    afterAll(async () => {
      redis.teardown();
    }, 300_000);

    it('serves commands once the master answers again', async () => {
      redis.stopMaster();
      // A 1s connect timeout keeps each failed discovery pass short.
      const client = buildSysClient(redis, lines, { timeout: 1000 });
      // Positive control: the first connect() gave up (the case this is about), before the master
      // came back.
      const gaveUp = () => lines.some((l) => l.msg === 'Redis connection failed (system)');
      const end = Date.now() + 150_000;
      while (!gaveUp() && Date.now() < end) await sleep(500);
      expect(gaveUp(), 'the initial connect() gave up').toBe(true);
      expect(redis.currentMaster()).toBe(redis.masterIp); // no failover happened
      const backAt = await redis.startMaster();
      const { ms: recoveryMs } = await firstSuccessAfter(
        () => client.set(key, 'back'),
        backAt,
        40_000
      );
      process.stdout.write(`[it] giveup: recoveryMs=${recoveryMs}\n`);
      expect(
        recoveryMs,
        `first write ${recoveryMs}ms after the master answered`
      ).toBeLessThanOrEqual(20_000);
      await expect(client.get(key)).resolves.toBe('back');
    }, 300_000);
  }
);
