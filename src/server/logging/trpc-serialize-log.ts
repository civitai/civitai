/**
 * Oversized / slow tRPC RESPONSE-SERIALIZATION instrumentation.
 *
 * WHY THIS EXISTS: civitai-dp-prod api-primary periodically 504/499s in bursts
 * when a single oversized tRPC response is serialized synchronously (superjson)
 * on the one JS thread, pegging the event loop for SECONDS and starving every
 * other in-flight request on the pod (a liveness kill on the worst pod). Captured
 * CPU profiles show the spin dominated by
 *   resolveResponse -> transformTRPCResponse -> transformer.serialize
 *     -> superjson.serialize (recursive walk) + GC churn
 * i.e. the block is in RESPONSE SERIALIZATION, which happens in tRPC's response
 * pipeline AFTER the resolver has already returned.
 *
 * THE BLIND SPOT THIS CLOSES: the sibling `trpc-slow-log.ts` times the RESOLVER
 * (the middleware chain + `next()`), so a procedure whose resolver is fast but
 * whose RESULT is huge-and-slow-to-serialize is invisible to it — the blocking
 * time is spent after the timed window closes. This module instruments the
 * serialize step itself and names the offending procedure on the NEXT occurrence:
 * it wraps the transformer's `serialize` (see src/server/trpc.ts) and, when a
 * single serialize is slow OR its output is oversized, emits ONE structured
 * `logToAxiom` line with { path, bytes, serializeMs, procedureType }.
 *   Query in Loki: `{namespace="civitai-dp-prod"} | json | name="trpc-response-oversized"`.
 *
 * PROCEDURE-PATH CORRELATION: the transformer's `serialize(data)` receives only
 * the payload, not the procedure it belongs to. tRPC does NOT thread the path
 * into the transformer, and there is no always-on OTEL procedure span to read
 * (OTEL is opt-in + 10%-sampled here, and only inbound-HTTP + manual withSpan
 * spans exist). So we correlate the path deterministically via a request-scoped
 * AsyncLocalStorage seeded at the HTTP-handler boundary (src/pages/api/trpc/[trpc].ts)
 * from `req.query.trpc` — the comma-joined batch procedure path(s) that are
 * already in the request URL. The serialize call runs inside that ALS scope
 * (resolveResponse is an awaited descendant of the wrapped handler), so
 * `currentSerializeCtx()` reads the request's path synchronously with no
 * async_hooks / per-resource cost. Batches are ~99% single-procedure (see the
 * dp-prod tRPC-batching note), so `path` is almost always the exact culprit; for
 * a multi-procedure batch it's the small candidate set (the oversized one is the
 * one whose serialize is slow). Outside an HTTP request (SSR createCaller / SSG
 * dehydration) there is no scope → path is 'unknown', still with bytes+serializeMs.
 *
 * Design guarantees (mirrors trpc-slow-log.ts / eventloop-longtask.ts):
 *  - CHEAP COMMON PATH. Per serialize the enabled path pays: one kill-switch check,
 *    one CACHED-config read (the env config is resolved once and refreshed on an
 *    interval, NOT rebuilt per call — see getSerializeConfig), two `performance.now()`
 *    reads and one numeric compare. Below `TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS`
 *    (default 50ms — a normal small response serializes in well under 1ms) it returns
 *    immediately with NO byte walk, NO per-call config allocation, NO log.
 *  - THE BYTE WALK NEVER RUNS PER-OCCURRENCE ON THE INCIDENT PATH. `safeByteLength`
 *    is a SECOND O(payload) JSON.stringify (a multi-MB string alloc for the monster
 *    responses this exists to catch), so running it once per serialize during an
 *    oversized-response WAVE would amplify the exact loop-block it measures. It is
 *    ordered AFTER the trigger + rate gate: for the loop-blocking case
 *    (serializeMs >= slowMs) DURATION ALONE decides, so the byte size is computed
 *    only AFTER the gate allows an emit (≤ maxPerSec times/window, informational);
 *    it is a decision INPUT only in the moderate band (floorMs <= serializeMs <
 *    slowMs — the smaller payloads that didn't block long enough, since the 6MB
 *    monsters take >250ms and hit the first branch). We NEVER double-serialize the
 *    common (sub-floor) path.
 *  - DISARMED (`TRPC_SERIALIZE_LOG_ENABLED` off): `instrumentSerialize` checks the
 *    kill-switch FIRST and returns the raw serialize in a single boolean branch —
 *    before any config is built — and the ALS wrapper at the handler boundary is
 *    skipped, so it is byte-for-byte the pre-instrumentation path.
 *  - NEVER throws, NEVER delays the request path — all logging is best-effort and
 *    swallowed; the serialize is timed INLINE (not in a finally), so a serialize
 *    throw propagates unchanged and correctly skips timing + logging (there is no
 *    output to size or attribute).
 *  - SELF-AMPLIFICATION GUARD: during a real wave many oversized responses cross at
 *    once; a per-pod PATH-DIVERSE token cap (`TRPC_SERIALIZE_LOG_MAX_PER_SEC`,
 *    default 50/s) bounds the stderr burst while still naming each distinct offender
 *    once/window. Lines suppressed by the hard CEILING are counted and surfaced as
 *    `droppedSinceLastLog` on the next emit; same-path repeats within a window are
 *    deduped (they carry no new which-procedure signal) and intentionally NOT counted.
 *  - PRIVACY: logs ONLY the procedure path, best-effort type, the serialized byte
 *    SIZE, and the duration. It does NOT log the payload or any field values, so no
 *    prompt / PII is ever captured. The `path` is the client-controlled `req.query.trpc`
 *    URL segment (a caller can put arbitrary text there), which is safe because
 *    `logToAxiom` JSON-encodes the value — it can't break the log structure — and it
 *    carries no PII beyond the requested procedure path itself.
 *
 * Env knobs (resolved into a short-lived cache, refreshed on an interval — tunable
 * without a rebuild; a change takes effect within one refresh interval):
 *  - TRPC_SERIALIZE_LOG_ENABLED (default true) — kill-switch; disabled ONLY by an
 *    explicit falsy token (false/0/no/off), so it can't be turned off by =yes/=on.
 *  - TRPC_SERIALIZE_SLOW_MS (default 250) — a single serialize taking >= this many
 *    ms is loop-blocking and logged. Normal serialize is sub-ms; the incident was
 *    ~6000ms. This is the AUTHORITATIVE loop-blocking trigger.
 *  - TRPC_SERIALIZE_OVERSIZED_BYTES (default 1048576 = 1 MiB) — serialized output at
 *    or above this size is logged even if it happened to serialize under SLOW_MS,
 *    as an early/proactive signal (the request body limit is 17mb; a 1MiB RESPONSE
 *    is already the danger zone that pegs the loop under concurrency).
 *  - TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS (default 50) — the cheap gate: below this
 *    serialize duration we do NOT compute the byte size or log. Anything that blocks
 *    the loop OR is oversized-enough-to-matter takes >= this long to superjson-walk,
 *    so the floor drops no actionable event while keeping the 1500 req/s common path
 *    free. Lower it (toward 0) during an active hunt to widen the size trigger.
 *  - TRPC_SERIALIZE_LOG_MAX_PER_SEC (default 50) — per-pod path-diverse ceiling.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const DEFAULT_SLOW_MS = 250;
const DEFAULT_OVERSIZED_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_SIZE_CHECK_FLOOR_MS = 50;
const DEFAULT_MAX_PER_SEC = 50;

// ---------------------------------------------------------------------------
// Env config (lazy, mirrors trpc-slow-log.ts)
// ---------------------------------------------------------------------------

// `min` lets a threshold reject 0 / negatives (which would mean "log everything",
// a firehose footgun) and fall back to the default instead.
function envNumber(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// Default-ON kill-switch: only an EXPLICIT falsy token disables. Avoids the footgun
// where an operator sets `=yes`/`=on` to "turn it on" and a strict `==='true'`
// check silently turns it OFF instead.
function envDisabled(name: string): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return false; // unset → enabled
  const v = raw.trim().toLowerCase();
  return v === 'false' || v === '0' || v === 'no' || v === 'off';
}

export interface SerializeLogConfig {
  enabled: boolean;
  slowMs: number;
  oversizedBytes: number;
  floorMs: number;
  maxPerSec: number;
}

/** Resolve the full config from env (fresh read — no cache). Exported for tests. */
export function resolveSerializeConfig(): SerializeLogConfig {
  return {
    enabled: !envDisabled('TRPC_SERIALIZE_LOG_ENABLED'),
    slowMs: envNumber('TRPC_SERIALIZE_SLOW_MS', DEFAULT_SLOW_MS, 1),
    oversizedBytes: envNumber('TRPC_SERIALIZE_OVERSIZED_BYTES', DEFAULT_OVERSIZED_BYTES, 1),
    floorMs: envNumber('TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS', DEFAULT_SIZE_CHECK_FLOOR_MS, 0),
    maxPerSec: envNumber('TRPC_SERIALIZE_LOG_MAX_PER_SEC', DEFAULT_MAX_PER_SEC, 1),
  };
}

// Cached config so the hot path (several thousand serializes/sec) does NOT re-read
// 5 env vars + allocate a fresh config object on every call. Resolved once and
// refreshed on a fixed interval so env overrides still take effect without a rebuild
// (within one CONFIG_TTL_MS window). Module-local, one cache per pod.
const CONFIG_TTL_MS = 5000;
let cachedConfig: SerializeLogConfig | undefined;
let cachedConfigAt = 0;

/** Cached config accessor — refreshes at most once per CONFIG_TTL_MS. */
function getSerializeConfig(now: number = Date.now()): SerializeLogConfig {
  if (cachedConfig === undefined || now - cachedConfigAt >= CONFIG_TTL_MS) {
    cachedConfig = resolveSerializeConfig();
    cachedConfigAt = now;
  }
  return cachedConfig;
}

/** TEST-ONLY: drop the cached config so an env change is picked up immediately. */
export function __resetConfigCacheForTests(): void {
  cachedConfig = undefined;
  cachedConfigAt = 0;
}

/**
 * Pure decision: given a measured serialize duration + byte size and the resolved
 * thresholds, should this serialize be logged? Factored out so the trigger logic
 * is unit-testable without a real serialize/timer. Fires when the serialize was
 * slow (loop-blocking) OR its output was oversized.
 *
 * NaN-safe: written as `>=` (not `!(<)`) so a NaN duration/size — `NaN >= x` is
 * false — is rejected rather than slipping through as a null-valued line.
 */
export function shouldLogSerialize(args: {
  serializeMs: number;
  bytes: number;
  slowMs: number;
  oversizedBytes: number;
}): boolean {
  const { serializeMs, bytes, slowMs, oversizedBytes } = args;
  return serializeMs >= slowMs || bytes >= oversizedBytes;
}

// ---------------------------------------------------------------------------
// Request-scoped procedure-path context (ALS)
// ---------------------------------------------------------------------------

export interface SerializeCtx {
  /** Comma-joined batch procedure path(s) from the request URL, e.g. `image.getInfinite`. */
  path: string;
  /** Best-effort tRPC kind derived from the HTTP method ('query' for GET). */
  type?: string;
}

const serializeCtxStorage = new AsyncLocalStorage<SerializeCtx>();

/**
 * Run `fn` with `ctx` as the active serialize-attribution context. Called at the
 * tRPC HTTP-handler boundary so the (awaited-descendant) serialize step can read
 * the request's procedure path. Gated on the enabled flag: when disabled this is a
 * direct `fn()` with NO ALS store created (zero added async-context cost), so the
 * disarmed request hot path is untouched.
 */
export function runWithSerializeCtx<T>(ctx: SerializeCtx, fn: () => T): T {
  if (envDisabled('TRPC_SERIALIZE_LOG_ENABLED')) return fn();
  return serializeCtxStorage.run(ctx, fn);
}

/**
 * Seed the serialize-attribution ctx UNCONDITIONALLY — independent of the
 * `TRPC_SERIALIZE_LOG_ENABLED` kill-switch. Use OFF the hot request path (e.g.
 * SSR dehydrate), where the async-context cost is negligible (once per page
 * render, not per tRPC batch at ~thousands/s) and we want the
 * devalue-write-fallback observer (src/server/trpc.ts) to be able to attribute
 * an SSR offender even when serialize-SLOW logging is turned off. The gated
 * `runWithSerializeCtx` stays the hot-path seed: decoupling the fallback
 * attribution from the slow-log kill-switch on the HTTP boundary too would
 * reintroduce the per-request async_hooks cost that gate exists to avoid.
 */
export function runWithSerializeCtxAlways<T>(ctx: SerializeCtx, fn: () => T): T {
  return serializeCtxStorage.run(ctx, fn);
}

/** Read the active request's serialize-attribution ctx (also used by the
 *  devalue-write-fallback logger in src/server/trpc.ts to name the offender). */
export function currentSerializeCtx(): SerializeCtx | undefined {
  return serializeCtxStorage.getStore();
}

/**
 * Derive the SerializeCtx from a Next API request. `req.query.trpc` is the single
 * `[trpc]` path segment — the comma-joined batch procedure path(s). Method is a
 * best-effort type hint: a GET is always a query; a POST may be a mutation OR a
 * method-overridden query (allowMethodOverride), so POST maps to undefined rather
 * than mislabel it. The path is the load-bearing field.
 */
export function serializeCtxFromRequest(req: {
  query?: Partial<{ trpc: string | string[] }>;
  method?: string;
}): SerializeCtx {
  const raw = req.query?.trpc;
  const path = (Array.isArray(raw) ? raw.join('/') : raw) || 'unknown';
  const type = (req.method || '').toUpperCase() === 'GET' ? 'query' : undefined;
  return { path, type };
}

/**
 * Build a stable, attribution-safe serialize `path` for an SSR dehydrate — so an
 * SSR devalue-write fallback (e.g. `/changelog`) attributes to the page instead
 * of `unknown`. Sanitizes the request URL's pathname so the marker survives the
 * devalue-fallback-dedup normalizer (which splits on `,` and `/`): leading
 * slashes trimmed, internal `/` → `.`, query string dropped — so the whole
 * marker is ONE attribution key (`ssr:dehydrate:user.[username].models`), never
 * fragmented. Empty → `ssr:dehydrate:root`.
 */
export function ssrDehydrateSerializePath(url: string | undefined): string {
  const pathname = (url ?? '').split('?')[0];
  const slug = pathname.replace(/^\/+/, '').replace(/\/+/g, '.') || 'root';
  return `ssr:dehydrate:${slug}`;
}

// ---------------------------------------------------------------------------
// Per-pod path-diverse rate limiter (mirrors trpc-slow-log.ts)
// ---------------------------------------------------------------------------

let rlWindowStartMs = 0;
let rlCountThisWindow = 0;
let rlDroppedSinceEmit = 0;
let rlSeenPaths = new Set<string>();

/**
 * Per-window, path-aware gate. Emits each distinct `path` at most once per 1s
 * window (a repeat carries no new "which-procedure" signal), with a hard ceiling
 * backstop. Returns the count suppressed-by-ceiling since the last EMITTED line
 * (to attach as `droppedSinceLastLog`), or -1 if THIS call must be suppressed.
 */
function rateGate(path: string, maxPerSec: number, now: number = Date.now()): number {
  if (now - rlWindowStartMs >= 1000) {
    rlWindowStartMs = now;
    rlCountThisWindow = 0;
    rlSeenPaths.clear();
  }
  if (rlSeenPaths.has(path)) return -1;
  if (rlCountThisWindow >= maxPerSec) {
    rlDroppedSinceEmit++;
    return -1;
  }
  rlSeenPaths.add(path);
  rlCountThisWindow++;
  const carried = rlDroppedSinceEmit;
  rlDroppedSinceEmit = 0;
  return carried;
}

// ---------------------------------------------------------------------------
// Byte-size measurement (only ever called above the floor — never common path)
// ---------------------------------------------------------------------------

/**
 * Serialized byte size of the transformer output. `result` is JSON-safe — either
 * a superjson `{ json, meta }` object or a devalue string (Phase 2) — so this is a
 * single JSON.stringify walk, the closest cheap proxy for the wire payload size.
 * NEVER runs on the common path (gated behind the duration floor). Returns
 * undefined if stringify fails, so a size-measurement failure never blocks a
 * duration-based log.
 */
function safeByteLength(result: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Emit (fire-and-forget, injectable sink for tests)
// ---------------------------------------------------------------------------

export interface SerializeLogPayload {
  path: string;
  bytes: number | undefined;
  serializeMs: number;
  procedureType?: string;
  slowMs: number;
  oversizedBytes: number;
  droppedSinceLastLog: number;
}

type EmitSink = (payload: SerializeLogPayload) => void;

let emitSink: EmitSink | undefined;

/** TEST-ONLY: capture emitted payloads instead of shipping to Axiom. */
export function __setEmitSinkForTests(sink: EmitSink | undefined): void {
  emitSink = sink;
}

const pendingEmits = new Set<Promise<void>>();

/** TEST-ONLY: resolve once every in-flight fire-and-forget emit tail has settled. */
export function __flushPendingEmitsForTest(): Promise<void> {
  return Promise.allSettled([...pendingEmits]).then(() => undefined);
}

/** TEST-ONLY: reset the per-pod rate-limiter window so tests don't share state. */
export function __resetRateLimitForTests(): void {
  rlWindowStartMs = 0;
  rlCountThisWindow = 0;
  rlDroppedSinceEmit = 0;
  rlSeenPaths.clear();
}

/** TEST-ONLY: drive `rateGate` with an explicit clock for deterministic assertions. */
export function __rateGateForTest(path: string, maxPerSec: number, now: number): number {
  return rateGate(path, maxPerSec, now);
}

function emit(payload: SerializeLogPayload): void {
  if (typeof window !== 'undefined') return; // defensive server-only guard
  if (emitSink) {
    emitSink(payload);
    return;
  }
  const tail = (async () => {
    try {
      const body: Record<string, unknown> = {
        name: 'trpc-response-oversized',
        type: 'warning',
        path: payload.path,
        serializeMs: payload.serializeMs,
        slowThresholdMs: payload.slowMs,
        oversizedThresholdBytes: payload.oversizedBytes,
      };
      if (payload.bytes != null) body.bytes = payload.bytes;
      if (payload.procedureType) body.procedureType = payload.procedureType;
      if (payload.droppedSinceLastLog > 0) body.droppedSinceLastLog = payload.droppedSinceLastLog;

      const { logToAxiom } = await import('~/server/logging/client');
      await logToAxiom(body);
    } catch {
      // Logging failure must never surface.
    }
  })();
  pendingEmits.add(tail);
  void tail.finally(() => pendingEmits.delete(tail));
}

// ---------------------------------------------------------------------------
// The serialize wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap the tRPC transformer's `serialize`. Checks the kill-switch FIRST (disabled →
 * a single boolean branch, no config built), then times the serialize INLINE (two
 * timestamps). Below the cheap duration floor it returns immediately. Above the
 * floor it decides whether to log WITHOUT paying the byte walk on the incident path:
 *
 *  - serializeMs >= slowMs (the loop-blocking case, e.g. the ~6s incident): duration
 *    alone qualifies, so we hit the RATE GATE FIRST and only compute the byte size
 *    (for the log payload) AFTER the gate allows an emit. On an oversized-response
 *    WAVE this means `safeByteLength` — a second full JSON.stringify — runs at most
 *    `maxPerSec` times/window on the already-blocked thread, not once per serialize.
 *  - floorMs <= serializeMs < slowMs (the moderate band, smaller payloads by
 *    definition): here the byte size is a decision INPUT for the oversized-SIZE
 *    trigger, so it is computed to evaluate `bytes >= oversizedBytes` before gating.
 *
 * Returns the raw serialize result unchanged; a serialize throw propagates unchanged
 * (timed inline — a throw skips timing + the size/log tail since there is no output).
 *
 * @param rawSerialize the real serialize (e.g. `() => superjson.serialize(data)`,
 *                      optionally wrapped in the existing withSpan). Its return
 *                      value is passed through verbatim.
 */
export function instrumentSerialize<T>(rawSerialize: () => T): T {
  // FIRST: kill-switch. Disabled → a single boolean branch, before any config is
  // built or allocated (mirrors runWithSerializeCtx's short-circuit).
  if (envDisabled('TRPC_SERIALIZE_LOG_ENABLED')) return rawSerialize();

  const cfg = getSerializeConfig(); // cached — not rebuilt per call

  const startedAt = performance.now();
  const result = rawSerialize();
  const serializeMs = performance.now() - startedAt;

  // Cheap common-path exit: a sub-floor serialize is neither loop-blocking nor
  // oversized-enough-to-matter — no byte walk, no log.
  if (!(serializeMs >= cfg.floorMs)) return result;

  try {
    const ctx = currentSerializeCtx();
    // `path` is the client-controlled `req.query.trpc` URL segment (see the ALS
    // seed in [trpc].ts). Safe to log: `logToAxiom` JSON-encodes it, and it carries
    // no PII beyond the requested procedure path.
    const path = ctx?.path ?? 'unknown';

    if (serializeMs >= cfg.slowMs) {
      // LOOP-BLOCKING: duration alone decides — gate BEFORE the byte walk so the
      // second stringify is not paid per-occurrence during a slow+wave incident.
      const dropped = rateGate(path, cfg.maxPerSec);
      if (dropped < 0) return result; // suppressed (dup-this-window or ceiling)
      const bytes = safeByteLength(result); // informational, only after the gate
      emit({
        path,
        bytes,
        serializeMs: Math.round(serializeMs * 100) / 100,
        procedureType: ctx?.type,
        slowMs: cfg.slowMs,
        oversizedBytes: cfg.oversizedBytes,
        droppedSinceLastLog: dropped,
      });
    } else {
      // MODERATE band (floorMs <= serializeMs < slowMs): the oversized-SIZE trigger
      // needs the byte size to decide. These are the smaller payloads (the 6MB
      // monsters block > slowMs and took the branch above).
      const bytes = safeByteLength(result);
      // serializeMs < slowMs here, so shouldLogSerialize reduces to the size trigger.
      if (
        !shouldLogSerialize({
          serializeMs,
          bytes: bytes ?? 0,
          slowMs: cfg.slowMs,
          oversizedBytes: cfg.oversizedBytes,
        })
      ) {
        return result;
      }
      const dropped = rateGate(path, cfg.maxPerSec);
      if (dropped < 0) return result; // suppressed (dup-this-window or ceiling)
      emit({
        path,
        bytes,
        serializeMs: Math.round(serializeMs * 100) / 100,
        procedureType: ctx?.type,
        slowMs: cfg.slowMs,
        oversizedBytes: cfg.oversizedBytes,
        droppedSinceLastLog: dropped,
      });
    }
  } catch {
    // Instrumentation must never throw into the serialize path.
  }
  return result;
}
