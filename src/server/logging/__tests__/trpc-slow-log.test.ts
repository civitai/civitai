import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the slow-tRPC-procedure instrumentation (trpc-slow-log.ts).
 *
 * It is the always-on, threshold-gated detector that NAMES the procedure behind
 * the api-primary/SSR latency tail (the gap the opt-in `trpcProcedureDuration`
 * metric + the Tempo root-span blind spot leave open). These tests assert:
 *  - it FIRES at/above TRPC_SLOW_LOG_MS and NOT below (NaN-safe),
 *  - 0/negative threshold + the enable flag behave (no firehose / no accidental-off),
 *  - the per-pod storm guard names each distinct path once/window, caps absolute
 *    volume, and surfaces the suppressed-by-ceiling count,
 *  - the payload names the procedure path/type/duration/ok (+ optional
 *    errorCode/userId/droppedSinceLastLog), never the procedure INPUT,
 *  - a logging failure can never throw into the caller.
 *
 * `~/server/logging/client` is mocked so the dynamic `import()` inside emitSlowLog
 * resolves without pulling in `~/env/server` (which throws under the unit env).
 */

const logToAxiom = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock('~/server/logging/client', () => ({ logToAxiom }));

import {
  maybeLogTrpcSlow,
  __resetTrpcSlowLogRateLimit,
  __rateGateForTest,
} from '~/server/logging/trpc-slow-log';

// Flush the fire-and-forget async tail: it awaits one dynamic import before
// calling logToAxiom, so a couple of macrotask hops are needed for it to settle.
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

const ENV_KEYS = ['TRPC_SLOW_LOG_ENABLED', 'TRPC_SLOW_LOG_MS', 'TRPC_SLOW_LOG_MAX_PER_SEC'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  logToAxiom.mockClear();
  __resetTrpcSlowLogRateLimit(); // module-level rate-limit state must not leak across tests
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('maybeLogTrpcSlow threshold gating', () => {
  it('does NOT emit when duration is below threshold', async () => {
    process.env.TRPC_SLOW_LOG_MS = '3000';
    maybeLogTrpcSlow({ path: 'image.getInfinite', type: 'query', durationMs: 120, ok: true });
    await flush();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('emits exactly once when duration is at/above threshold', async () => {
    process.env.TRPC_SLOW_LOG_MS = '3000';
    maybeLogTrpcSlow({ path: 'image.getInfinite', type: 'query', durationMs: 12000, ok: true });
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('respects a custom threshold from TRPC_SLOW_LOG_MS', async () => {
    process.env.TRPC_SLOW_LOG_MS = '100';
    maybeLogTrpcSlow({ path: 'model.getAll', type: 'query', durationMs: 250, ok: true });
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('uses the 5000ms default when TRPC_SLOW_LOG_MS is unset', async () => {
    delete process.env.TRPC_SLOW_LOG_MS;
    maybeLogTrpcSlow({ path: 'x.y', type: 'query', durationMs: 4999, ok: true });
    maybeLogTrpcSlow({ path: 'x.y', type: 'query', durationMs: 5000, ok: true });
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('treats TRPC_SLOW_LOG_MS=0 as the default (not "log everything")', async () => {
    process.env.TRPC_SLOW_LOG_MS = '0';
    maybeLogTrpcSlow({ path: 'x.y', type: 'query', durationMs: 200, ok: true }); // under default 5000
    await flush();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('does NOT emit on a NaN duration (NaN-safe gate)', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: NaN, ok: true });
    await flush();
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});

describe('maybeLogTrpcSlow kill-switch', () => {
  it('does not emit when TRPC_SLOW_LOG_ENABLED=false', async () => {
    process.env.TRPC_SLOW_LOG_ENABLED = 'false';
    process.env.TRPC_SLOW_LOG_MS = '1000';
    maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: 99999, ok: true });
    await flush();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('stays ENABLED for non-falsy values like "yes"/"on" (no accidental-off footgun)', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    for (const v of ['yes', 'on', 'true', '1', 'enabled']) {
      logToAxiom.mockClear();
      __resetTrpcSlowLogRateLimit();
      process.env.TRPC_SLOW_LOG_ENABLED = v;
      maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: 9000, ok: true });
      await flush();
      expect(logToAxiom, `value ${v} should keep logging enabled`).toHaveBeenCalledTimes(1);
    }
  });

  it('is disabled by any explicit falsy token (0/no/off)', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    for (const v of ['0', 'no', 'off', 'FALSE']) {
      logToAxiom.mockClear();
      __resetTrpcSlowLogRateLimit();
      process.env.TRPC_SLOW_LOG_ENABLED = v;
      maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: 9000, ok: true });
      await flush();
      expect(logToAxiom, `value ${v} should disable`).not.toHaveBeenCalled();
    }
  });
});

describe('rateGate (per-pod, path-diverse storm guard)', () => {
  // Deterministic clock — explicit `now`, no fake timers.
  it('names each distinct path once per window and suppresses same-path repeats', () => {
    expect(__rateGateForTest('a', 50, 1000)).toBe(0); // emit 'a'
    expect(__rateGateForTest('a', 50, 1000)).toBe(-1); // same path this window → suppressed
    expect(__rateGateForTest('b', 50, 1500)).toBe(0); // distinct → emit
    expect(__rateGateForTest('b', 50, 1999)).toBe(-1); // dup → suppressed
    // New window (>=1000ms after window start 1000): 'a' nameable again.
    expect(__rateGateForTest('a', 50, 2000)).toBe(0);
  });

  it('enforces the hard ceiling across distinct paths and carries the dropped count', () => {
    // cap = 2: two distinct paths emit; further distinct paths hit the ceiling.
    expect(__rateGateForTest('p1', 2, 1000)).toBe(0); // emit
    expect(__rateGateForTest('p2', 2, 1000)).toBe(0); // emit
    expect(__rateGateForTest('p3', 2, 1000)).toBe(-1); // ceiling → dropped=1
    expect(__rateGateForTest('p4', 2, 1500)).toBe(-1); // ceiling → dropped=2
    // New window: first emit carries the 2 ceiling-suppressed lines.
    expect(__rateGateForTest('p1', 2, 2000)).toBe(2);
    expect(__rateGateForTest('p2', 2, 2000)).toBe(0); // emit, nothing pending
  });

  it('dup suppressions do NOT inflate the ceiling drop count', () => {
    expect(__rateGateForTest('a', 1, 1000)).toBe(0); // emit
    expect(__rateGateForTest('a', 1, 1000)).toBe(-1); // dup (not a ceiling drop)
    expect(__rateGateForTest('a', 1, 1000)).toBe(-1); // dup
    // New window: 'a' emits again, carry is 0 (the dups above were not "dropped").
    expect(__rateGateForTest('a', 1, 2000)).toBe(0);
  });
});

describe('maybeLogTrpcSlow payload', () => {
  it('names the procedure and includes type/duration/threshold/ok — and NO input', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    maybeLogTrpcSlow({ path: 'image.getInfinite', type: 'query', durationMs: 7345.678, ok: true });
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.name).toBe('trpc-procedure-slow');
    expect(payload.type).toBe('warning');
    expect(payload.path).toBe('image.getInfinite');
    expect(payload.procedureType).toBe('query');
    expect(payload.durationMs).toBe(7345.68); // rounded to 2dp
    expect(payload.thresholdMs).toBe(1000);
    expect(payload.ok).toBe(true);
    // No input/raw field is ever attached (privacy).
    expect(Object.keys(payload)).not.toContain('input');
    expect(Object.keys(payload)).not.toContain('rawInput');
  });

  it('includes errorCode + userId only when provided', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    maybeLogTrpcSlow({
      path: 'orchestrator.generate',
      type: 'mutation',
      durationMs: 30000,
      ok: false,
      errorCode: 'TIMEOUT',
      userId: 42,
    });
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('TIMEOUT');
    expect(payload.userId).toBe(42);
    expect(payload.procedureType).toBe('mutation');
  });

  it('omits errorCode/userId/droppedSinceLastLog keys when not applicable', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: 5000, ok: true });
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('errorCode');
    expect(Object.keys(payload)).not.toContain('userId');
    expect(Object.keys(payload)).not.toContain('droppedSinceLastLog');
  });

  it('attaches droppedSinceLastLog to the payload after ceiling drops (end-to-end)', async () => {
    // Fake only Date so rateGate's window can be rolled deterministically while the
    // real setTimeout in flush() still works. The two EMITTING calls are separated
    // by a flush, so each lands (no concurrent-import dedup).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_000_000));
    process.env.TRPC_SLOW_LOG_MS = '1000';
    process.env.TRPC_SLOW_LOG_MAX_PER_SEC = '1';

    maybeLogTrpcSlow({ path: 'p1', type: 'query', durationMs: 5000, ok: true }); // emit
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(1);

    maybeLogTrpcSlow({ path: 'p2', type: 'query', durationMs: 5000, ok: true }); // ceiling drop
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(1); // still 1

    vi.setSystemTime(new Date(1_002_000)); // new window
    maybeLogTrpcSlow({ path: 'p3', type: 'query', durationMs: 5000, ok: true }); // emit, carries 1
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(2);
    expect((logToAxiom.mock.calls[1][0] as Record<string, unknown>).droppedSinceLastLog).toBe(1);
  });
});

describe('maybeLogTrpcSlow safety', () => {
  it('never throws when the logging client rejects', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    logToAxiom.mockImplementationOnce(() => Promise.reject(new Error('axiom down')));
    expect(() =>
      maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: 9000, ok: true })
    ).not.toThrow();
    await flush();
    // The rejection is swallowed — no unhandled throw reaches the caller.
  });
});
