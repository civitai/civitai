import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClusterSelfHealWatchdog } from '../cluster-selfheal';
import type { ClusterSelfHealConfig, ClusterSelfHealDeps } from '../cluster-selfheal';

// ClusterSelfHealWatchdog is the FIX #1 self-heal for the node-redis cluster inflight-leak
// wedge: when a pod's tracked cluster inflight stays PINNED above the threshold for a
// sustained window, force exactly ONE reconnect (subject to a cooldown), the only thing that
// clears the orphaned `_execute` promises short of a process restart. The watchdog is pure
// (no redis/prom imports) and driven by tick() against a fake clock + injected counter, so we
// can prove: a sustained breach fires exactly one reconnect; a transient spike does NOT; the
// cooldown bounds reconnect frequency; disabled is a no-op; the reconnect counter fires with
// the inflight-at-trigger value; a reconnect rejection doesn't wedge the watchdog. Mirrors
// command-deadline.test.ts / client.test.ts (each fix in this area regressed once — lock it).

const DEFAULTS: ClusterSelfHealConfig = {
  enabled: true,
  inflightThreshold: 50,
  sustainedMs: 20000,
  cooldownMs: 60000,
};

/** Test harness: a controllable clock + inflight value + spy reconnect/onReconnect. */
function makeHarness(
  cfg: Partial<ClusterSelfHealConfig> = {},
  opts: { reconnect?: () => Promise<void> } = {}
) {
  let nowMs = 0;
  let inflight = 0;
  const reconnect = vi.fn(opts.reconnect ?? (() => Promise.resolve()));
  const onReconnect = vi.fn();
  const log = vi.fn();
  const deps: ClusterSelfHealDeps = {
    getInflight: () => inflight,
    reconnect,
    now: () => nowMs,
    log,
    onReconnect,
  };
  const watchdog = new ClusterSelfHealWatchdog({ ...DEFAULTS, ...cfg }, deps);
  return {
    watchdog,
    reconnect,
    onReconnect,
    log,
    setInflight: (v: number) => (inflight = v),
    advance: (ms: number) => (nowMs += ms),
    setNow: (ms: number) => (nowMs = ms),
    now: () => nowMs,
  };
}

/** Flush all pending microtasks (the reconnect's then→catch→finally chain settles). */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Drive ticks across `ms` at `step` granularity (simulates the watchdog interval). */
function runFor(h: ReturnType<typeof makeHarness>, ms: number, step = 1000): number {
  let fires = 0;
  for (let t = 0; t < ms; t += step) {
    if (h.watchdog.tick()) fires++;
    h.advance(step);
  }
  return fires;
}

describe('ClusterSelfHealWatchdog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires exactly one reconnect when inflight stays pinned above the threshold for the sustained window', async () => {
    const h = makeHarness();
    h.setInflight(500); // wedged: pinned well above 50

    // Below the sustained window: no reconnect yet.
    const firesEarly = runFor(h, DEFAULTS.sustainedMs, 1000); // ticks across exactly the window
    expect(firesEarly).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();

    // One more tick now that now-breachStart >= sustainedMs → trigger.
    expect(h.watchdog.tick()).toBe(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.onReconnect).toHaveBeenCalledTimes(1);
    // onReconnect carries the inflight value at trigger time (for the Prom counter/Loki line).
    expect(h.onReconnect).toHaveBeenCalledWith(500);

    await flush(); // let the fire-and-forget reconnect settle
  });

  it('does NOT fire on a transient spike that drops back under the threshold before the window elapses', () => {
    const h = makeHarness();
    h.setInflight(500); // spike up
    // Spike lasts only ~half the window.
    runFor(h, DEFAULTS.sustainedMs / 2, 1000);
    expect(h.reconnect).not.toHaveBeenCalled();

    // Drops back to healthy — the sustained timer must RESET.
    h.setInflight(0);
    h.watchdog.tick();
    expect(h.watchdog.getState().breachStartedAt).toBeNull();

    // Spike again, but again only briefly: still no reconnect (timer restarted from here).
    h.setInflight(500);
    runFor(h, DEFAULTS.sustainedMs / 2, 1000);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('respects the cooldown — at most one reconnect per cooldown window even while inflight stays pinned', async () => {
    const h = makeHarness();
    h.setInflight(500); // stays wedged the whole time

    // First trigger after the sustained window.
    runFor(h, DEFAULTS.sustainedMs, 1000);
    expect(h.watchdog.tick()).toBe(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await flush(); // reconnect resolves → reconnecting=false

    // Keep ticking through the cooldown while still pinned: no second reconnect.
    const firesDuringCooldown = runFor(h, DEFAULTS.cooldownMs, 1000);
    expect(firesDuringCooldown).toBe(0);
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    // Past the cooldown while still wedged, exactly ONE more reconnect fires (the breach
    // timer kept running through the cooldown, so it's already satisfied). Drive a generous
    // window and assert the count, since the firing tick is consumed inside runFor.
    const firesAfterCooldown = runFor(h, DEFAULTS.sustainedMs + 2000, 1000);
    expect(firesAfterCooldown).toBe(1);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('is a no-op when disabled (kill switch): never reconnects, clears the breach timer', () => {
    const h = makeHarness({ enabled: false });
    h.setInflight(100000); // extreme wedge
    const fires = runFor(h, DEFAULTS.sustainedMs * 5, 1000);
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.onReconnect).not.toHaveBeenCalled();
    expect(h.watchdog.getState().breachStartedAt).toBeNull();
  });

  it('does not fire while inflight equals the threshold exactly (strictly-above only)', () => {
    const h = makeHarness();
    h.setInflight(DEFAULTS.inflightThreshold); // == 50, not > 50
    const fires = runFor(h, DEFAULTS.sustainedMs * 2, 1000);
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('single-flights: does not start a second reconnect while one is in progress', async () => {
    // A reconnect that resolves only when we let it, to hold reconnecting=true.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = makeHarness({}, { reconnect: () => gate });
    h.setInflight(500);

    runFor(h, DEFAULTS.sustainedMs, 1000);
    expect(h.watchdog.tick()).toBe(true); // first trigger, reconnect pending
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    // While the reconnect is pending, further ticks (even past another window) must NOT
    // start a second reconnect.
    runFor(h, DEFAULTS.sustainedMs * 3, 1000);
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    release();
    await gate;
    await flush();
    expect(h.watchdog.getState().reconnecting).toBe(false);
  });

  it('survives a rejecting reconnect: logs it, clears reconnecting, and re-arms after cooldown', async () => {
    const err = new Error('disconnect failed');
    const h = makeHarness({}, { reconnect: () => Promise.reject(err) });
    h.setInflight(500);

    runFor(h, DEFAULTS.sustainedMs, 1000);
    expect(h.watchdog.tick()).toBe(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    // Let the rejected reconnect settle.
    await flush();
    expect(h.watchdog.getState().reconnecting).toBe(false);
    // The failure was logged, not thrown.
    expect(h.log.mock.calls.some(([m]) => String(m).includes('reconnect failed'))).toBe(true);

    // After the cooldown it can try again (still wedged). The firing tick is consumed inside
    // runFor, so assert on the reconnect count over a generous window.
    runFor(h, DEFAULTS.cooldownMs, 1000);
    const firesAgain = runFor(h, DEFAULTS.sustainedMs + 2000, 1000);
    expect(firesAgain).toBe(1);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('tick() never throws even if the onReconnect hook throws, and still reconnects', async () => {
    const h = makeHarness();
    h.onReconnect.mockImplementation(() => {
      throw new Error('counter boom');
    });
    h.setInflight(500);
    runFor(h, DEFAULTS.sustainedMs, 1000);
    // A throwing onReconnect (a broken Prom counter) must NOT abort the reconnect or wedge
    // the watchdog: tick still returns true, the reconnect still fires, and reconnecting
    // clears once it settles.
    expect(() => h.watchdog.tick()).not.toThrow();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.watchdog.getState().reconnecting).toBe(false);
    expect(h.watchdog.getState().breachStartedAt).toBeNull();
  });
});
