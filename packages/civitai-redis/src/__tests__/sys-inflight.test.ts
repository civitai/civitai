import { describe, it, expect, beforeEach } from 'vitest';
import {
  decSysInflight,
  getSysInflight,
  incSysInflight,
  resetSysInflight,
} from '../sys-inflight';
import { ClusterSelfHealWatchdog } from '../cluster-selfheal';
import type { ClusterSelfHealConfig, ClusterSelfHealDeps } from '../cluster-selfheal';

// The sys inflight counter is the exact mirror of cluster-inflight for the sysRedis / Sentinel
// client (incident 2026-07-03: a sentinel flap orphaned in-flight commands → inflight climbed to
// 7,000–253,000 per pod and never self-healed). Same floor invariant: forceSysReconnect calls the
// sentinel client's destroy() (rejects every in-flight command immediately); each rejected command
// then runs done() → decSysInflight(). Without a global floor those N decrements (a per-closure
// guard, no floor) drive the counter to ≈ −N, so the watchdog needs inflight > threshold + N to
// ever re-trigger → a SECOND wedge goes unhealed. These tests exercise the REAL counter (the same
// module client.ts uses) and assert the floor holds + the watchdog re-arms.

describe('sys-inflight counter (floor)', () => {
  beforeEach(() => resetSysInflight());

  it('increments and decrements in lockstep on the happy path', () => {
    expect(getSysInflight()).toBe(0);
    incSysInflight();
    incSysInflight();
    expect(getSysInflight()).toBe(2);
    expect(decSysInflight()).toBe(1);
    expect(decSysInflight()).toBe(0);
    expect(getSysInflight()).toBe(0);
  });

  it('FLOORS at 0 — a decrement when already at 0 never goes negative', () => {
    expect(getSysInflight()).toBe(0);
    expect(decSysInflight()).toBe(0);
    expect(decSysInflight()).toBe(0);
    expect(getSysInflight()).toBe(0);
  });

  it('post-heal: reset()→0 then N late rejected decrements settle at 0, NOT -N', () => {
    // N commands in flight (across BOTH sys connections) when the wedge fires.
    const N = 7;
    for (let i = 0; i < N; i++) incSysInflight();
    expect(getSysInflight()).toBe(N);

    // forceSysReconnect resets up front (the watchdog's sampled value snaps clean)...
    resetSysInflight();
    expect(getSysInflight()).toBe(0);

    // ...then each of the N destroy()-rejected commands runs its done() → floored decrement.
    // Without the floor this would leave the counter at -N; the floor keeps it at 0.
    for (let i = 0; i < N; i++) decSysInflight();
    expect(getSysInflight()).toBe(0);
  });
});

// Integration: drive the REAL (reused) watchdog with the REAL sys counter as getInflight, simulate
// a wedge → heal → post-heal rejected decrements, and prove a SECOND wedge still triggers a
// reconnect (the counter re-armed because it floored at 0 instead of going negative). This is the
// exact mirror of the cluster suite, with the SYS default geometry (threshold 500 vs cluster 50,
// deadline trigger OFF — the sys client has no per-command deadline).
describe('sys self-heal watchdog re-arms after a heal (real sys counter)', () => {
  const CFG: ClusterSelfHealConfig = {
    enabled: true,
    inflightThreshold: 500,
    sustainedMs: 20000,
    cooldownMs: 60000,
    // Deadline trigger disabled (the sys client has no command deadline); no jitter so the
    // reconnect fires synchronously and the assertions stay deterministic.
    deadlineHitThreshold: 0,
    deadlineHitWindowMs: 0,
    reconnectJitterMs: 0,
  };

  beforeEach(() => resetSysInflight());

  it('a second wedge after a heal still triggers a reconnect (counter floored, not negative)', async () => {
    let nowMs = 0;
    let reconnectCount = 0;
    // Model forceSysReconnect's counter handling against the REAL counter: reset up front, then the
    // N previously-in-flight commands reject and floored-decrement.
    const reconnect = (): Promise<void> => {
      reconnectCount++;
      const n = getSysInflight();
      resetSysInflight(); // up-front reset
      for (let i = 0; i < n; i++) decSysInflight(); // late rejected done()s, floored
      return Promise.resolve();
    };
    const deps: ClusterSelfHealDeps = {
      getInflight: () => getSysInflight(),
      reconnect,
      now: () => nowMs,
      log: () => {},
      onReconnect: () => {},
    };
    const watchdog = new ClusterSelfHealWatchdog(CFG, deps);

    // ── First wedge: 7000 commands pinned in flight (incident magnitude) ──
    for (let i = 0; i < 7000; i++) incSysInflight();
    for (let t = 0; t < CFG.sustainedMs; t += 1000) {
      watchdog.tick();
      nowMs += 1000;
    }
    expect(watchdog.tick()).toBe(true); // first heal fires
    await new Promise((r) => setTimeout(r, 0)); // let the reconnect settle
    expect(reconnectCount).toBe(1);
    // After the heal the counter floored at 0 (NOT -7000).
    expect(getSysInflight()).toBe(0);

    // Advance past the cooldown so the watchdog can re-arm.
    nowMs += CFG.cooldownMs + 1000;

    // ── Second wedge: another genuine pin. With a negative counter this could never reach the
    // threshold again; floored at 0 it can. ──
    for (let i = 0; i < 7000; i++) incSysInflight();
    expect(getSysInflight()).toBe(7000);
    let secondFired = false;
    for (let t = 0; t < CFG.sustainedMs + 2000; t += 1000) {
      if (watchdog.tick()) secondFired = true;
      nowMs += 1000;
    }
    expect(secondFired).toBe(true);
    expect(reconnectCount).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(getSysInflight()).toBe(0);
  });
});
