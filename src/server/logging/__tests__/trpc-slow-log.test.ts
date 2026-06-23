import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the slow-tRPC-procedure instrumentation (trpc-slow-log.ts).
 *
 * It is the always-on, threshold-gated detector that NAMES the procedure behind
 * the api-primary/SSR latency tail (the gap the opt-in `trpcProcedureDuration`
 * metric + the Tempo root-span blind spot leave open). These tests assert:
 *  - it FIRES at/above TRPC_SLOW_LOG_MS and NOT below,
 *  - the payload names the procedure path/type/duration/ok (+ optional errorCode/userId),
 *  - it never logs the procedure INPUT (no PII leak),
 *  - a logging failure can never throw into the caller.
 *
 * `~/server/logging/client` is mocked so the dynamic `import()` inside emitSlowLog
 * resolves without pulling in `~/env/server` (which throws under the unit env).
 */

const logToAxiom = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock('~/server/logging/client', () => ({ logToAxiom }));

import { maybeLogTrpcSlow } from '~/server/logging/trpc-slow-log';

// Flush the fire-and-forget async tail: it awaits one dynamic import before
// calling logToAxiom, so a couple of macrotask hops are needed for it to settle.
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

const ENV_KEYS = ['TRPC_SLOW_LOG_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  logToAxiom.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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

  it('uses the 3000ms default when TRPC_SLOW_LOG_MS is unset', async () => {
    delete process.env.TRPC_SLOW_LOG_MS;
    maybeLogTrpcSlow({ path: 'x.y', type: 'query', durationMs: 2999, ok: true });
    maybeLogTrpcSlow({ path: 'x.y', type: 'query', durationMs: 3000, ok: true });
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
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

  it('omits errorCode/userId keys when not provided', async () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: 5000, ok: true });
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('errorCode');
    expect(Object.keys(payload)).not.toContain('userId');
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

  it('never throws on a malformed/NaN duration', () => {
    process.env.TRPC_SLOW_LOG_MS = '1000';
    expect(() =>
      maybeLogTrpcSlow({ path: 'a.b', type: 'query', durationMs: NaN, ok: true })
    ).not.toThrow();
  });
});
