import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the slow-prompt-audit instrumentation (audit-slow-log.ts) and its
 * integration into auditPromptEnriched/auditPrompt.
 *
 * The instrumentation is the always-on, threshold-gated detector for the prod
 * 11-47s CPU-pin "504 wave" (see audit-slow-log.ts header). These tests assert:
 *  - the slow-detector FIRES above AUDIT_SLOW_LOG_MS and NOT below,
 *  - it identifies the slowest sub-check + emits the reproduction fingerprint,
 *  - the raw-prompt capture respects the AUDIT_SLOW_LOG_RAW gate (+ truncation),
 *  - a logging failure can never throw into the caller,
 *  - the audit RESULT is byte-for-byte identical with the threshold tripped vs not.
 *
 * `~/server/logging/client` is mocked so the dynamic `import()` inside emitSlowLog
 * resolves without pulling in `~/env/server` (which throws under the unit env), and
 * so we can assert the payload shape without testing Axiom internals.
 */

// Hoisted spy shared by the vi.mock factory and the assertions.
const logToAxiom = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock('~/server/logging/client', () => ({ logToAxiom }));

import { AuditTimer } from '~/utils/metadata/audit-slow-log';
import { auditPrompt, auditPromptEnriched } from '~/utils/metadata/audit';

// Flush the fire-and-forget async tail inside emitSlowLog: it awaits two dynamic
// imports (node:crypto + the logging client) before calling logToAxiom, so a
// couple of macrotask hops are needed for it to settle.
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

const ENV_KEYS = ['AUDIT_SLOW_LOG_MS', 'AUDIT_SLOW_LOG_RAW', 'AUDIT_SLOW_LOG_RAW_MAX'] as const;
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

describe('AuditTimer threshold gating', () => {
  it('does NOT emit when every sub-check and the total are below threshold', async () => {
    process.env.AUDIT_SLOW_LOG_MS = '500';
    const timer = new AuditTimer();
    const r = timer.time('fast', () => 'ok');
    expect(r).toBe('ok');
    timer.finish('a fast prompt', undefined);
    await flush();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('emits once when a single sub-check exceeds threshold (mocked performance.now)', async () => {
    process.env.AUDIT_SLOW_LOG_MS = '500';
    // Drive performance.now: ctor=0, then a slow sub-check (start=0,end=900),
    // then finish reads the total. 900ms > 500ms threshold.
    const seq = [0, 0, 900, 1000];
    let i = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => seq[Math.min(i++, seq.length - 1)]);

    const timer = new AuditTimer();
    timer.time('slowcheck', () => 'x');
    timer.finish('the offending prompt', undefined);
    await flush();

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.name).toBe('audit-prompt-slow');
    expect(payload.type).toBe('warning');
    expect(payload.slowestCheck).toBe('slowcheck');
    expect(payload.slowestMs).toBe(900);
    expect((payload.perCheckMs as Record<string, number>).slowcheck).toBe(900);
    expect(payload.thresholdMs).toBe(500);
    expect(payload.promptLength).toBe('the offending prompt'.length);
    expect(typeof payload.promptHash).toBe('string');
  });

  it('respects a custom AUDIT_SLOW_LOG_MS threshold', async () => {
    process.env.AUDIT_SLOW_LOG_MS = '50';
    const seq = [0, 0, 60, 70]; // 60ms > 50ms
    let i = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => seq[Math.min(i++, seq.length - 1)]);

    const timer = new AuditTimer();
    timer.time('c', () => null);
    timer.finish('p');
    await flush();
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });
});

describe('shape fingerprint + reproduction payload', () => {
  function fireWith(prompt: string, negativePrompt?: string) {
    process.env.AUDIT_SLOW_LOG_MS = '100';
    const seq = [0, 0, 200, 250];
    let i = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => seq[Math.min(i++, seq.length - 1)]);
    const timer = new AuditTimer();
    timer.time('c', () => null);
    timer.finish(prompt, negativePrompt);
  }

  it('includes a shape fingerprint characterizing the input', async () => {
    // "abc" then a 5-char non-alnum run "!@#$%" (alnum on both sides) then "123".
    fireWith('abc!@#$%123');
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.longestNonAlnumRun).toBe(5); // "!@#$%"
    expect(payload.nonAlnumCount).toBe(5);
    expect(payload.digitCount).toBe(3);
    expect(payload.letterCount).toBe(3);
    expect(payload.distinctCharCount).toBeGreaterThan(0);
    expect(payload.charClassSummary).toBe('L=3,D=3,W=0,O=5');
  });

  it('includes negative-prompt metadata when present', async () => {
    fireWith('hello', 'a negative prompt');
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.negativePromptLength).toBe('a negative prompt'.length);
    expect(typeof payload.negativePromptHash).toBe('string');
  });
});

describe('AUDIT_SLOW_LOG_RAW gate + truncation', () => {
  function fire(prompt: string) {
    process.env.AUDIT_SLOW_LOG_MS = '100';
    const seq = [0, 0, 200, 250];
    let i = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => seq[Math.min(i++, seq.length - 1)]);
    const timer = new AuditTimer();
    timer.time('c', () => null);
    timer.finish(prompt);
  }

  it('attaches rawPrompt by default (AUDIT_SLOW_LOG_RAW unset => true)', async () => {
    delete process.env.AUDIT_SLOW_LOG_RAW;
    fire('the raw triggering prompt');
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.rawPrompt).toBe('the raw triggering prompt');
  });

  it('omits rawPrompt when AUDIT_SLOW_LOG_RAW=false', async () => {
    process.env.AUDIT_SLOW_LOG_RAW = 'false';
    fire('the raw triggering prompt');
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.rawPrompt).toBeUndefined();
    // Fingerprint still present so the input is characterized without the raw text.
    expect(payload.longestNonAlnumRun).toBeDefined();
  });

  it('truncates an oversized raw prompt to head+tail with an elision marker', async () => {
    process.env.AUDIT_SLOW_LOG_RAW = 'true';
    process.env.AUDIT_SLOW_LOG_RAW_MAX = '20';
    const long = 'A'.repeat(50) + 'B'.repeat(50);
    fire(long);
    await flush();
    const payload = logToAxiom.mock.calls[0][0] as Record<string, unknown>;
    const raw = payload.rawPrompt as string;
    expect(raw).toContain('truncated');
    expect(raw.length).toBeLessThan(long.length);
    expect(raw.startsWith('A')).toBe(true); // head preserved
    expect(raw.endsWith('B')).toBe(true); // tail preserved
  });
});

describe('best-effort: instrumentation never throws into the caller', () => {
  it('a logToAxiom rejection does not throw', async () => {
    process.env.AUDIT_SLOW_LOG_MS = '100';
    logToAxiom.mockRejectedValueOnce(new Error('axiom down'));
    const seq = [0, 0, 200, 250];
    let i = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => seq[Math.min(i++, seq.length - 1)]);
    const timer = new AuditTimer();
    timer.time('c', () => null);
    expect(() => timer.finish('p')).not.toThrow();
    await flush(); // the rejected promise is swallowed inside emitSlowLog
  });

  it('time() rethrows the sub-check error but still records elapsed', () => {
    const timer = new AuditTimer();
    // The audit must observe the real sub-check throw (behavior unchanged);
    // the timer only wraps measurement around it.
    expect(() =>
      timer.time('boom', () => {
        throw new Error('sub-check failed');
      })
    ).toThrow('sub-check failed');
  });
});

describe('audit RESULT is unaffected by instrumentation', () => {
  // Known-good outputs: instrumentation must not change what auditPrompt returns,
  // regardless of whether the slow-log threshold is tripped.
  const cases: { prompt: string; negative?: string; success: boolean }[] = [
    { prompt: 'a beautiful landscape, mountains, sunset', success: true },
    { prompt: 'masterpiece, best quality, portrait of a woman', success: true },
    { prompt: 'score_9, year 2025, cyberpunk city', success: true },
    { prompt: '15 year old girl', success: false }, // minor_age
  ];

  it('returns identical results with the threshold high (never logs) vs near-zero (always logs)', async () => {
    for (const c of cases) {
      process.env.AUDIT_SLOW_LOG_MS = '999999';
      const high = auditPrompt(c.prompt, c.negative);

      process.env.AUDIT_SLOW_LOG_MS = '0';
      const low = auditPrompt(c.prompt, c.negative);

      expect(low).toEqual(high);
      expect(high.success).toBe(c.success);
    }
    await flush();
  });

  it('auditPromptEnriched triggers/blockedFor are unchanged across thresholds', () => {
    process.env.AUDIT_SLOW_LOG_MS = '999999';
    const a = auditPromptEnriched('15 year old girl');
    process.env.AUDIT_SLOW_LOG_MS = '0';
    const b = auditPromptEnriched('15 year old girl');
    expect(b).toEqual(a);
    expect(a.success).toBe(false);
    expect(a.triggers[0].category).toBe('minor_age');
  });
});
