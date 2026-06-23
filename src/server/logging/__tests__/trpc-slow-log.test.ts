import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the slow-tRPC-procedure instrumentation (trpc-slow-log.ts).
 *
 * It is the always-on, threshold-gated detector that NAMES the procedure behind
 * the api-primary/SSR latency tail (the gap the opt-in `trpcProcedureDuration`
 * metric + the Tempo root-span blind spot leave open). These tests assert:
 *  - it FIRES at/above TRPC_SLOW_LOG_MS and NOT below (NaN-safe),
 *  - 0/negative threshold + the enable flag behave (no firehose footgun),
 *  - the per-pod storm guard caps emits/sec and surfaces the suppressed count,
 *  - the payload names the procedure path/type/duration/ok (+ optional errorCode/userId),
 *  - it never logs the procedure INPUT (no PII leak),
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

  it('does not emit at all when TRPC_SLOW_LOG_ENABLED=false', async () => {
    process.env.TRPC_SLOW_LOG_ENABLED = 'false';
    process.env.TRPC_SLOW_LOG_MS = '1000';
    maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: 99999, ok: true });
    await flush();
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});

describe('maybeLogTrpcSlow per-pod storm guard (rateGate)', () => {
  // The cap is exercised at the gate level with a DETERMINISTIC clock (injected
  // `now`), which fully covers M1: emit up to the cap, suppress the rest, and never
  // silently drop — carry the suppressed count onto the next emitted line. (An
  // integration assertion on logToAxiom call-count is intentionally NOT used here:
  // vitest dedups concurrent `await import()` of a vi.mock'd module, which would
  // make a "N concurrent emits → K logs" assertion flaky for a test-only reason.
  // The glue maybeLogTrpcSlow→rateGate→emit is covered by the other tests.)
  it('emits up to the cap, suppresses the rest, and carries the dropped count into the next window', () => {
    // cap = 2 per 1000ms window.
    expect(__rateGateForTest(2, 1000)).toBe(0); // emit #1 (window opens)
    expect(__rateGateForTest(2, 1000)).toBe(0); // emit #2
    expect(__rateGateForTest(2, 1000)).toBe(-1); // suppressed (dropped=1)
    expect(__rateGateForTest(2, 1500)).toBe(-1); // still same window, suppressed (dropped=2)
    // New window (>=1000ms later): first emit carries the 2 suppressed lines.
    expect(__rateGateForTest(2, 2000)).toBe(2);
    expect(__rateGateForTest(2, 2000)).toBe(0); // emit #2 of the new window, nothing pending
    expect(__rateGateForTest(2, 2000)).toBe(-1); // suppressed again
  });

  it('a cap of 1 emits the first and suppresses subsequent in-window', () => {
    expect(__rateGateForTest(1, 5000)).toBe(0); // emit
    expect(__rateGateForTest(1, 5000)).toBe(-1); // suppressed
    expect(__rateGateForTest(1, 5999)).toBe(-1); // suppressed (same window)
    expect(__rateGateForTest(1, 6000)).toBe(2); // new window: emit, carries the 2 dropped
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
