import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forceSysReconnect } from '../client';
import {
  decSysInflight,
  getSysInflight,
  incSysInflight,
  resetSysInflight,
} from '../sys-inflight';
import { ClusterSelfHealWatchdog } from '../cluster-selfheal';
import type { ClusterSelfHealConfig, ClusterSelfHealDeps } from '../cluster-selfheal';

// Sys (sysRedis / Sentinel) self-heal — the mirror of the cluster self-heal for the OTHER
// node-redis client (incident 2026-07-03: a sentinel flap orphaned in-flight commands → inflight
// 7,000–253,000 per pod, every request touching sysRedis hung, no self-heal until a manual pod
// delete). Two things to lock:
//   1. forceSysReconnect: the sentinel destroy→connect correctness — reconnects ALL sys base
//      connections, prefers destroy() over the queue-draining close(), resets the counter, and
//      NEVER throws into the hot path (teardown/connect errors are swallowed).
//   2. The reused ClusterSelfHealWatchdog wired with SYS geometry (deadline trigger OFF, since the
//      sys client has no per-command deadline): below-threshold no-op, sustained-high fires with an
//      'inflight' trigger, disabled no-op, reconnect rejection doesn't wedge the watchdog.

/** A fake node-redis Sentinel client with destroy()/connect() spies. */
function makeFakeSentinel(opts: { destroyThrows?: boolean; connectThrows?: boolean } = {}) {
  const client = {
    destroyed: 0,
    connected: 0,
    destroy: vi.fn(async () => {
      client.destroyed++;
      if (opts.destroyThrows) throw new Error('destroy boom');
    }),
    connect: vi.fn(async () => {
      client.connected++;
      if (opts.connectThrows) throw new Error('connect boom');
      return client;
    }),
  };
  return client;
}

describe('forceSysReconnect (sentinel destroy→connect correctness)', () => {
  beforeEach(() => resetSysInflight());

  it('destroys THEN connects EVERY sys base client (serving + Buffer-mode)', async () => {
    const serving = makeFakeSentinel();
    const buffer = makeFakeSentinel();

    await forceSysReconnect([serving, buffer]);

    expect(serving.destroy).toHaveBeenCalledTimes(1);
    expect(serving.connect).toHaveBeenCalledTimes(1);
    expect(buffer.destroy).toHaveBeenCalledTimes(1);
    expect(buffer.connect).toHaveBeenCalledTimes(1);
    // destroy must precede connect on each client (a connect on a live client would be a no-op /
    // wrong — the whole point is to tear the wedged sockets down first).
    expect(serving.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      serving.connect.mock.invocationCallOrder[0]
    );
  });

  it('resets the sys inflight counter up front (the sampled value snaps clean at the trigger)', async () => {
    for (let i = 0; i < 7000; i++) incSysInflight();
    expect(getSysInflight()).toBe(7000);

    // A reconnect whose connect() asserts the counter was already reset before it ran.
    const client = makeFakeSentinel();
    let inflightSeenAtConnect = -1;
    client.connect.mockImplementation(async () => {
      inflightSeenAtConnect = getSysInflight();
      return client;
    });

    await forceSysReconnect([client]);
    expect(inflightSeenAtConnect).toBe(0);
    expect(getSysInflight()).toBe(0);
  });

  it('prefers destroy() over close() (close would hang on the wedged queue)', async () => {
    const close = vi.fn(async () => undefined);
    const client = { ...makeFakeSentinel(), close };
    await forceSysReconnect([client]);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('swallows a teardown throw and STILL connects (never throws into the hot path)', async () => {
    const client = makeFakeSentinel({ destroyThrows: true });
    await expect(forceSysReconnect([client])).resolves.toBeUndefined();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    // The destroy throw must not skip the reconnect.
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('swallows a connect() throw (background retry continues) — never rejects', async () => {
    const client = makeFakeSentinel({ connectThrows: true });
    await expect(forceSysReconnect([client])).resolves.toBeUndefined();
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('one bad client does not prevent the others from reconnecting', async () => {
    const bad = makeFakeSentinel({ destroyThrows: true, connectThrows: true });
    const good = makeFakeSentinel();
    await expect(forceSysReconnect([bad, good])).resolves.toBeUndefined();
    expect(good.destroy).toHaveBeenCalledTimes(1);
    expect(good.connect).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null/undefined entry in the client list', async () => {
    const client = makeFakeSentinel();
    await expect(forceSysReconnect([undefined, client])).resolves.toBeUndefined();
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});

// The sys watchdog reuses ClusterSelfHealWatchdog with sys geometry. These lock the wiring the
// package uses (deadline trigger OFF → the ONLY trigger is sustained-inflight, exactly the incident
// signature: a monotonic climb, no sawtooth).
const SYS_CFG: ClusterSelfHealConfig = {
  enabled: true,
  inflightThreshold: 500,
  sustainedMs: 20000,
  cooldownMs: 60000,
  deadlineHitThreshold: 0, // sys has no per-command deadline
  deadlineHitWindowMs: 0,
  reconnectJitterMs: 0,
};

function makeSysHarness(cfg: Partial<ClusterSelfHealConfig> = {}) {
  let nowMs = 0;
  let inflight = 0;
  const reconnect = vi.fn(() => Promise.resolve());
  const onReconnect = vi.fn();
  const log = vi.fn();
  const deps: ClusterSelfHealDeps = {
    // NOTE: getDeadlineHits is intentionally OMITTED, exactly as startSysSelfHeal wires it.
    getInflight: () => inflight,
    reconnect,
    now: () => nowMs,
    log,
    onReconnect,
  };
  const watchdog = new ClusterSelfHealWatchdog({ ...SYS_CFG, ...cfg }, deps);
  return {
    watchdog,
    reconnect,
    onReconnect,
    log,
    setInflight: (v: number) => (inflight = v),
    advance: (ms: number) => (nowMs += ms),
    runFor(ms: number, step = 1000) {
      let fires = 0;
      for (let t = 0; t < ms; t += step) {
        if (watchdog.tick()) fires++;
        nowMs += step;
      }
      return fires;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sys self-heal watchdog (sustained-inflight only)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT reconnect while sys inflight stays below the threshold', () => {
    const h = makeSysHarness();
    h.setInflight(400); // healthy-ish burst, under 500
    const fires = h.runFor(SYS_CFG.sustainedMs * 3);
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('reconnects when sys inflight stays pinned above the threshold for the sustained window, tagged "inflight"', async () => {
    const h = makeSysHarness();
    h.setInflight(7000); // incident magnitude

    expect(h.runFor(SYS_CFG.sustainedMs)).toBe(0); // not yet — window not elapsed
    expect(h.watchdog.tick()).toBe(true); // window elapsed → fire
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    // The sys client has no deadline trigger, so it's always the sustained-inflight path.
    expect(h.onReconnect).toHaveBeenCalledWith(7000, 'inflight');
    await flush();
  });

  it('is a no-op when disabled (REDIS_SYS_SELFHEAL_ENABLED=false)', () => {
    const h = makeSysHarness({ enabled: false });
    h.setInflight(250000); // extreme wedge
    const fires = h.runFor(SYS_CFG.sustainedMs * 5);
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.onReconnect).not.toHaveBeenCalled();
  });

  it('a rejecting reconnect does not wedge the watchdog (swallowed + re-arms after cooldown)', async () => {
    const h = makeSysHarness();
    h.reconnect.mockImplementation(() => Promise.reject(new Error('sentinel down')));
    h.setInflight(7000);

    h.runFor(SYS_CFG.sustainedMs);
    expect(h.watchdog.tick()).toBe(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.watchdog.getState().reconnecting).toBe(false); // cleared, not stuck
    expect(h.log.mock.calls.some(([m]) => String(m).includes('reconnect failed'))).toBe(true);

    // Past the cooldown, still wedged → exactly one more attempt.
    h.runFor(SYS_CFG.cooldownMs);
    const firesAgain = h.runFor(SYS_CFG.sustainedMs + 2000);
    expect(firesAgain).toBe(1);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('does not fire while inflight equals the threshold exactly (strictly-above only)', () => {
    const h = makeSysHarness();
    h.setInflight(SYS_CFG.inflightThreshold); // == 500, not > 500
    const fires = h.runFor(SYS_CFG.sustainedMs * 2);
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});
