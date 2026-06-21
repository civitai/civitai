import { describe, it, expect, beforeEach } from 'vitest';
import {
  decClusterInflight,
  getClusterInflight,
  incClusterInflight,
  resetClusterInflight,
} from '../cluster-inflight';
import { ClusterSelfHealWatchdog } from '../cluster-selfheal';
import type { ClusterSelfHealConfig, ClusterSelfHealDeps } from '../cluster-selfheal';

// FIX #2 coverage: the cluster inflight counter that the self-heal watchdog samples must
// NEVER go negative — specifically after a heal. forceClusterReconnect calls the cluster
// client's destroy() (flushAll(DisconnectsClientError)), which IMMEDIATELY rejects every
// in-flight command; each rejected command then runs done() → decClusterInflight(). Before
// FIX #2 those N decrements (a per-closure guard, no global floor) drove the counter to ≈ −N
// permanently, so the watchdog needed inflight > threshold + N to ever re-trigger → a SECOND
// wedge went unhealed. These tests exercise the REAL counter (the same module client.ts uses,
// not a stubbed constant) through the reset→decrement interaction and assert the floor holds
// and the watchdog can re-arm afterwards.

describe('cluster-inflight counter (FIX #2 floor)', () => {
  beforeEach(() => resetClusterInflight());

  it('increments and decrements in lockstep on the happy path', () => {
    expect(getClusterInflight()).toBe(0);
    incClusterInflight();
    incClusterInflight();
    expect(getClusterInflight()).toBe(2);
    expect(decClusterInflight()).toBe(1);
    expect(decClusterInflight()).toBe(0);
    expect(getClusterInflight()).toBe(0);
  });

  it('FLOORS at 0 — a decrement when already at 0 never goes negative', () => {
    expect(getClusterInflight()).toBe(0);
    expect(decClusterInflight()).toBe(0);
    expect(decClusterInflight()).toBe(0);
    expect(getClusterInflight()).toBe(0);
  });

  it('post-heal: reset()→0 then N late rejected decrements settle at 0, NOT -N', () => {
    // N commands in flight when the wedge fires.
    const N = 7;
    for (let i = 0; i < N; i++) incClusterInflight();
    expect(getClusterInflight()).toBe(N);

    // forceClusterReconnect resets up front (the watchdog's sampled value snaps clean)...
    resetClusterInflight();
    expect(getClusterInflight()).toBe(0);

    // ...then each of the N destroy()-rejected commands runs its done() → floored decrement.
    // Pre-FIX-#2 this would have left the counter at -N; the floor keeps it at 0.
    for (let i = 0; i < N; i++) decClusterInflight();
    expect(getClusterInflight()).toBe(0);
  });
});

// Integration: drive the REAL watchdog with the REAL counter as getInflight (not a constant),
// simulate a wedge → heal → post-heal rejected decrements, and prove a SECOND wedge still
// triggers a reconnect (the counter re-armed because it floored at 0 instead of going negative).
describe('ClusterSelfHealWatchdog re-arms after a heal (FIX #2, real counter)', () => {
  const CFG: ClusterSelfHealConfig = {
    enabled: true,
    inflightThreshold: 50,
    sustainedMs: 20000,
    cooldownMs: 60000,
  };

  beforeEach(() => resetClusterInflight());

  it('a second wedge after a heal still triggers a reconnect (counter floored, not negative)', async () => {
    let nowMs = 0;
    let reconnectCount = 0;
    // The reconnect models forceClusterReconnect's counter handling against the REAL counter:
    // reset up front, then the N previously-in-flight commands reject and floored-decrement.
    const nInFlightAtHeal = () => getClusterInflight();
    const reconnect = (): Promise<void> => {
      reconnectCount++;
      const n = nInFlightAtHeal();
      resetClusterInflight(); // up-front reset
      for (let i = 0; i < n; i++) decClusterInflight(); // late rejected done()s, floored
      return Promise.resolve();
    };
    const deps: ClusterSelfHealDeps = {
      getInflight: () => getClusterInflight(),
      reconnect,
      now: () => nowMs,
      log: () => {},
      onReconnect: () => {},
    };
    const watchdog = new ClusterSelfHealWatchdog(CFG, deps);

    // ── First wedge: 500 commands pinned in flight ──
    for (let i = 0; i < 500; i++) incClusterInflight();
    // Drive ticks across the sustained window.
    for (let t = 0; t < CFG.sustainedMs; t += 1000) {
      watchdog.tick();
      nowMs += 1000;
    }
    expect(watchdog.tick()).toBe(true); // first heal fires
    await new Promise((r) => setTimeout(r, 0)); // let the reconnect settle
    expect(reconnectCount).toBe(1);
    // After the heal the counter floored at 0 (NOT -500).
    expect(getClusterInflight()).toBe(0);

    // Advance past the cooldown so the watchdog can re-arm.
    nowMs += CFG.cooldownMs + 1000;

    // ── Second wedge: another genuine pin. With a negative counter this could never reach
    // threshold again; floored at 0 it can. ──
    for (let i = 0; i < 500; i++) incClusterInflight();
    expect(getClusterInflight()).toBe(500);
    let secondFired = false;
    for (let t = 0; t < CFG.sustainedMs + 2000; t += 1000) {
      if (watchdog.tick()) secondFired = true;
      nowMs += 1000;
    }
    expect(secondFired).toBe(true);
    expect(reconnectCount).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(getClusterInflight()).toBe(0);
  });
});
