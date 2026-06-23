/**
 * Slow-prompt-audit instrumentation.
 *
 * INCIDENT (the reason this exists): civitai-dp-prod api pods periodically pin a
 * CPU core at 100% for 11-47 SECONDS during the recurring "504 wave". A V8 CPU
 * profile proved the pin lives in `src/utils/metadata/audit.ts` prompt-matching
 * (captured frames `inPrompt` / `blockedFor`) — a single synchronous call burning
 * tens of seconds on a USER generation prompt, pegging the event loop until the
 * readiness probe times out and the pod sheds traffic. It is a user-triggerable
 * DoS. We could NOT reproduce it from the regex shapes alone: `auditPrompt` runs
 * several sub-checks (age-detection, the NSFW `inPrompt` word-list gate, the
 * ~1573-entry POI list, paddle/soft lists, the blocklist regex loop) and we don't
 * know WHICH sub-check or WHAT input triggers it.
 *
 * This module is the always-on, threshold-gated detector that captures that on the
 * NEXT stall: it records `performance.now()` deltas around each sub-check (cheap,
 * a couple of timestamps — no allocation below threshold) and, only when the total
 * audit OR any single sub-check exceeds `AUDIT_SLOW_LOG_MS`, emits ONE structured
 * `logToAxiom` line identifying the slowest sub-check and a fingerprint (and,
 * privacy-gated, the raw prompt) sufficient to reproduce the input.
 *
 * Design guarantees:
 *  - NEVER throws, NEVER delays the hot path. All hashing + logging is best-effort
 *    and wrapped so an instrumentation error can't break or slow the actual audit.
 *  - The audit RESULT is byte-for-byte unchanged — this only measures around it.
 *  - Below threshold: just the timestamps; no logging, no string/hash work.
 *  - Server-only side effects. `audit.ts` is also imported into the client bundle,
 *    so the node-only bits (`node:crypto`, `logToAxiom`) are lazy-required behind a
 *    `typeof window === 'undefined'` runtime guard and never pulled into a client
 *    import graph at module-eval time.
 *
 * PRIVACY: `AUDIT_SLOW_LOG_RAW` (default true) attaches the raw prompt, truncated
 * to `AUDIT_SLOW_LOG_RAW_MAX` bytes (first+last half), to make a backtrack
 * reproducible. Logs go to internal Axiom/Loki, never public. Because this is an
 * active DoS, capturing the raw triggering prompt is worth the tradeoff — but an
 * operator can set `AUDIT_SLOW_LOG_RAW=false` to drop it and rely on the shape
 * fingerprint alone.
 */

// Env knobs — read lazily per-call from process.env so they're tunable without a
// rebuild and so this file pulls in no `~/env/*` (client-leaky) imports.
const DEFAULT_SLOW_MS = 500;
const DEFAULT_RAW = true;
const DEFAULT_RAW_MAX = 2048; // first 1KB + last 1KB

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

/**
 * Per-audit timing accumulator. One is created per `auditPrompt` call (cheap —
 * a small object + a number array). `time()` wraps a sub-check, records its
 * elapsed ms, and returns the sub-check's own result untouched.
 */
export class AuditTimer {
  private readonly perCheckMs: Record<string, number> = {};
  private readonly startedAt = performance.now();

  /** Run `fn` (a sub-check), record its wall-clock ms under `name`, return its result verbatim. */
  time<T>(name: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      // Accumulate so a check that runs twice (e.g. POI on prompt + negative) sums.
      this.perCheckMs[name] = (this.perCheckMs[name] ?? 0) + (performance.now() - start);
    }
  }

  /**
   * Threshold check + emit. Call on EVERY return path of the audited function.
   * Best-effort: any failure here is swallowed and never affects the caller.
   */
  finish(prompt: string, negativePrompt?: string): void {
    try {
      const totalMs = performance.now() - this.startedAt;
      const slowMs = envNumber('AUDIT_SLOW_LOG_MS', DEFAULT_SLOW_MS);

      let slowestCheck = '';
      let slowestMs = 0;
      for (const [name, ms] of Object.entries(this.perCheckMs)) {
        if (ms > slowestMs) {
          slowestMs = ms;
          slowestCheck = name;
        }
      }

      // Below threshold (the overwhelming common case): do nothing. No allocation,
      // no hashing, no log.
      if (totalMs < slowMs && slowestMs < slowMs) return;

      emitSlowLog({
        totalMs,
        slowestCheck,
        slowestMs,
        perCheckMs: this.perCheckMs,
        prompt,
        negativePrompt,
        slowMs,
      });
    } catch {
      // Instrumentation must never throw into the audit hot path.
    }
  }
}

interface SlowLogInput {
  totalMs: number;
  slowestCheck: string;
  slowestMs: number;
  perCheckMs: Record<string, number>;
  prompt: string;
  negativePrompt?: string;
  slowMs: number;
}

/**
 * Build the payload + emit. Server-only (guarded). Returns synchronously; the
 * hash + Axiom write happen in a fire-and-forget async tail whose rejection is
 * swallowed, so the audit caller is never blocked or affected.
 */
function emitSlowLog(input: SlowLogInput): void {
  // Client-bundle guard: never touch node-only modules in the browser. The
  // dynamic `import()`s below are code-split into a server-only chunk and the
  // guard ensures they're never reached client-side at runtime.
  if (typeof window !== 'undefined') return;

  const { totalMs, slowestCheck, slowestMs, perCheckMs, prompt, negativePrompt, slowMs } = input;

  const fingerprint = shapeFingerprint(prompt);
  const includeRaw = envBool('AUDIT_SLOW_LOG_RAW', DEFAULT_RAW);
  const rawMax = envNumber('AUDIT_SLOW_LOG_RAW_MAX', DEFAULT_RAW_MAX);

  // Round per-check ms so the payload is small + readable (sub-ms precision is noise here).
  const round = (n: number) => Math.round(n * 100) / 100;
  const roundedPerCheck: Record<string, number> = {};
  for (const [k, v] of Object.entries(perCheckMs)) roundedPerCheck[k] = round(v);

  // Async tail — best-effort, fully swallowed. Kept off the synchronous return so
  // the audit hot path never waits on hashing or the Axiom client.
  void (async () => {
    try {
      const payload: Record<string, unknown> = {
        name: 'audit-prompt-slow',
        type: 'warning',
        totalMs: round(totalMs),
        slowestCheck,
        slowestMs: round(slowestMs),
        thresholdMs: slowMs,
        perCheckMs: roundedPerCheck,
        promptLength: prompt.length,
        promptHash: await stableHash(prompt),
        ...fingerprint,
      };
      if (negativePrompt) {
        payload.negativePromptLength = negativePrompt.length;
        payload.negativePromptHash = await stableHash(negativePrompt);
      }
      if (includeRaw) {
        payload.rawPrompt = truncateMiddle(prompt, rawMax);
        if (negativePrompt) payload.rawNegativePrompt = truncateMiddle(negativePrompt, rawMax);
      }

      // Dynamic server-only import (code-split, never in the client bundle).
      const { logToAxiom } = await import('~/server/logging/client');
      await logToAxiom(payload);
    } catch {
      // Instrumentation/log failure must never surface.
    }
  })();
}

/**
 * SHA-1 of the prompt (stable across pods, lets us dedup the same triggering
 * input in Axiom). Server-only; falls back to a cheap non-crypto hash if
 * `node:crypto` is unavailable for any reason. Never throws.
 */
async function stableHash(value: string): Promise<string> {
  try {
    const { createHash } = await import('node:crypto');
    return createHash('sha1').update(value).digest('hex');
  } catch {
    return 'fnv1a_' + fnv1a(value);
  }
}

/** Non-crypto fallback hash (FNV-1a, 32-bit) — deterministic, never throws. */
function fnv1a(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Characterize the pathological input WITHOUT needing the raw text. Catastrophic
 * backtracking blows up on input STRUCTURE — long runs of non-alphanumerics,
 * sparse alphanumerics — so these scalars are the actionable signal even when the
 * raw prompt is privacy-suppressed.
 */
function shapeFingerprint(value: string): Record<string, number | string> {
  let nonAlnumCount = 0;
  let longestNonAlnumRun = 0;
  let curRun = 0;
  let whitespaceCount = 0;
  let digitCount = 0;
  let letterCount = 0;
  const distinct = new Set<number>();

  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    distinct.add(c);
    const isDigit = c >= 48 && c <= 57;
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    const isAlnum = isDigit || isUpper || isLower;
    if (isDigit) digitCount++;
    else if (isUpper || isLower) letterCount++;
    if (c === 32 || c === 9 || c === 10 || c === 13) whitespaceCount++;
    if (isAlnum) {
      curRun = 0;
    } else {
      nonAlnumCount++;
      curRun++;
      if (curRun > longestNonAlnumRun) longestNonAlnumRun = curRun;
    }
  }

  return {
    longestNonAlnumRun,
    nonAlnumCount,
    distinctCharCount: distinct.size,
    whitespaceCount,
    digitCount,
    letterCount,
    // Short char-class summary, e.g. "L=120,D=4,W=18,O=6" (Letters/Digits/Whitespace/Other).
    charClassSummary: `L=${letterCount},D=${digitCount},W=${whitespaceCount},O=${
      nonAlnumCount - whitespaceCount
    }`,
  };
}

/**
 * Truncate to `max` bytes keeping the head AND tail (the structure that triggers a
 * backtrack often sits at a boundary), with an elision marker carrying the dropped
 * length. Returns the input unchanged when already within bounds.
 */
function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.max(1, Math.floor(max / 2));
  const head = value.slice(0, half);
  const tail = value.slice(value.length - half);
  return `${head}…[truncated ${value.length - 2 * half} chars]…${tail}`;
}
