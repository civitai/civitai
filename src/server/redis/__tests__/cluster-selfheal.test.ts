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
  // Default the deadline-hit trigger OFF in this harness so the legacy inflight-path tests
  // below are unaffected; the deadline-trigger tests opt in explicitly.
  deadlineHitThreshold: 0,
  deadlineHitWindowMs: 20000,
};

/** Test harness: a controllable clock + inflight value + spy reconnect/onReconnect. */
function makeHarness(
  cfg: Partial<ClusterSelfHealConfig> = {},
  opts: { reconnect?: () => Promise<void> } = {}
) {
  let nowMs = 0;
  let inflight = 0;
  let deadlineHits = 0;
  const reconnect = vi.fn(opts.reconnect ?? (() => Promise.resolve()));
  const onReconnect = vi.fn();
  const resetDeadlineHits = vi.fn(() => {
    deadlineHits = 0;
  });
  const log = vi.fn();
  const deps: ClusterSelfHealDeps = {
    getInflight: () => inflight,
    getDeadlineHits: () => deadlineHits,
    resetDeadlineHits,
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
    resetDeadlineHits,
    log,
    setInflight: (v: number) => (inflight = v),
    setDeadlineHits: (v: number) => (deadlineHits = v),
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
    // onReconnect carries the inflight value at trigger time + which trigger fired (for the
    // Prom counter label / Loki line). This is the legacy sustained-inflight path → 'inflight'.
    expect(h.onReconnect).toHaveBeenCalledWith(500, 'inflight');

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

  // ── DEADLINE-HIT TRIGGER (the fix for the real-wave non-firing bug) ────────────────

  it('REGRESSION: a sawtoothing inflight (deadline drains it every ~15s) never fires the inflight trigger', () => {
    // Reproduces the live bug: the 15s command deadline mass-rejects parked commands, so
    // inflight crashes below the threshold within each 20s sustained window → breachStartedAt
    // keeps resetting → the inflight trigger can NEVER accumulate. Deadline trigger OFF here to
    // isolate the inflight path. Simulate the sawtooth: ~14s pinned high, then a 1s crash to 0.
    const h = makeHarness({ deadlineHitThreshold: 0 });
    let fires = 0;
    for (let cycle = 0; cycle < 10; cycle++) {
      h.setInflight(200);
      for (let t = 0; t < 14000; t += 1000) {
        if (h.watchdog.tick()) fires++;
        h.advance(1000);
      }
      // Deadline batch rejects → inflight crashes below threshold for one sample.
      h.setInflight(0);
      if (h.watchdog.tick()) fires++;
      h.advance(1000);
    }
    // ~150s of a real half-open wedge, zero reconnects — exactly the observed prod behavior.
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('FIX: the deadline-hit trigger fires on the SAME sawtoothing wedge, regardless of inflight dips', async () => {
    // Same sawtooth, but now the deadline-hit trigger is armed (the drains ARE the hits, so the
    // hit count stays high even while inflight dips). It must fire on the very first tick once
    // the hit count is at/above threshold, without needing any inflight continuity.
    const h = makeHarness({ deadlineHitThreshold: 10, deadlineHitWindowMs: 20000 });
    h.setInflight(0); // inflight can be ANYTHING — deadline trigger is independent of it
    h.setDeadlineHits(25); // 25 deadline timeouts in the last 20s window >= 10

    expect(h.watchdog.tick()).toBe(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.onReconnect).toHaveBeenCalledTimes(1);
    // onReconnect is told WHICH trigger fired so client.ts emits the `trigger="deadline"`
    // metric label — the series we watch at the next prod wave to confirm THIS path fired.
    expect(h.onReconnect).toHaveBeenCalledWith(expect.any(Number), 'deadline');
    // The window is cleared on trigger so the same pre-heal hits can't immediately re-fire.
    expect(h.resetDeadlineHits).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('does NOT fire the deadline trigger below the hit threshold (a one-off transient slow command)', () => {
    const h = makeHarness({ deadlineHitThreshold: 10, deadlineHitWindowMs: 20000 });
    h.setInflight(0);
    h.setDeadlineHits(9); // one short of the threshold
    const fires = runFor(h, DEFAULTS.sustainedMs * 3, 1000);
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('deadline trigger respects the cooldown (one reconnect per cooldown even while hits stay high)', async () => {
    const h = makeHarness({ deadlineHitThreshold: 10, deadlineHitWindowMs: 20000 });
    h.setInflight(0);
    h.setDeadlineHits(100); // stays wedged

    expect(h.watchdog.tick()).toBe(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await flush();

    // resetDeadlineHits zeroed the window; the wedge keeps producing hits, re-arming it.
    h.setDeadlineHits(100);
    // Within the cooldown: no second reconnect.
    const firesDuringCooldown = runFor(h, DEFAULTS.cooldownMs, 1000);
    expect(firesDuringCooldown).toBe(0);
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    // Past the cooldown, still wedged → exactly one more.
    h.setDeadlineHits(100);
    const firesAfter = runFor(h, 3000, 1000);
    expect(firesAfter).toBe(1);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('deadline trigger is inert when its threshold is 0 (falls back to the inflight path only)', () => {
    const h = makeHarness({ deadlineHitThreshold: 0 });
    h.setInflight(0);
    h.setDeadlineHits(100000); // enormous, but the trigger is disabled
    const fires = runFor(h, DEFAULTS.sustainedMs * 3, 1000);
    expect(fires).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('deadline trigger is inert when getDeadlineHits dep is omitted (back-compat)', () => {
    // A caller (or older test) that doesn't supply getDeadlineHits must behave as before.
    let nowMs = 0;
    let inflight = 0;
    const reconnect = vi.fn(() => Promise.resolve());
    const deps: ClusterSelfHealDeps = {
      getInflight: () => inflight,
      reconnect,
      now: () => nowMs,
      log: vi.fn(),
      onReconnect: vi.fn(),
    };
    const watchdog = new ClusterSelfHealWatchdog(
      { ...DEFAULTS, deadlineHitThreshold: 10 },
      deps
    );
    inflight = 0; // inflight path never trips
    for (let t = 0; t < DEFAULTS.sustainedMs * 3; t += 1000) {
      watchdog.tick();
      nowMs += 1000;
    }
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('still fires the inflight trigger when inflight genuinely stays pinned (no deadline drain)', async () => {
    // Belt-and-suspenders: a wedge that leaks inflight WITHOUT deadline-rejecting (e.g. deadline
    // disabled) must still be caught by the legacy continuous-breach path.
    const h = makeHarness({ deadlineHitThreshold: 10 });
    h.setInflight(200); // pinned, never dips
    h.setDeadlineHits(0); // no deadline hits at all
    runFor(h, DEFAULTS.sustainedMs, 1000);
    expect(h.watchdog.tick()).toBe(true);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    // Reported as the legacy 'inflight' trigger (no deadline hits) → metric label distinguishes it.
    expect(h.onReconnect).toHaveBeenCalledWith(expect.any(Number), 'inflight');
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
