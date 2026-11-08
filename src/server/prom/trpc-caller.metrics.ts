import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';

// ---------------------------------------------------------------------------
// tRPC caller class: who spends procedure time, by path
// ---------------------------------------------------------------------------
//
// Two counters with the same labels, recorded once per procedure call beside the duration
// histogram (`civitai_app_trpc_procedure_duration_seconds`) and with the same `path` value, so
// the three join on `path`:
//   - `civitai_app_trpc_caller_total{path,caller}`: calls.
//   - `civitai_app_trpc_caller_seconds_sum{path,caller}`: wall-clock seconds those calls took.
// No buckets: the histogram already carries the latency shape, this only splits the volume and
// the time by caller class.
//
// CARDINALITY: `caller` takes exactly the five values in TRPC_CALLER_CLASSES, never anything
// derived from the request. A user agent is matched against a fixed token list and only the
// resulting class is a label. `path` is the procedure name, the same bounded set as the histogram.
//
// HOT PATH: one anchored regex test on the user agent (anonymous callers only) and two number
// additions per call. A prom-client `inc` costs a label hash and validation (~0.4 us each, measured),
// so calls accumulate in plain per-(path, caller) cells and are folded into the counters by the
// counters' own `collect`, which prom-client runs on every scrape. A call allocates nothing after
// the first one for its pair. `caller` must be one of TRPC_CALLER_CLASSES: the type enforces it
// and `safeClassifyTrpcCaller` is the only producer.

export const TRPC_CALLER_TOTAL_METRIC = PROM_PREFIX + 'trpc_caller_total';
export const TRPC_CALLER_SECONDS_METRIC = PROM_PREFIX + 'trpc_caller_seconds_sum';

export const TRPC_CALLER_CLASSES = [
  'session',
  'api_key',
  'anon_browser',
  'anon_tool_ua',
  'internal',
] as const;
export type TrpcCallerClass = (typeof TRPC_CALLER_CLASSES)[number];

/**
 * User-agent prefixes of HTTP libraries and command-line tools. Matched case-insensitively at the
 * START of the user agent and up to a word boundary, so `python` covers `python-requests/2.31`,
 * `Python-urllib/3.11` and `Python/3.11 aiohttp/3.9`, and a browser user agent that merely
 * contains one of these words later on (`Mozilla/5.0 ... curl`) stays a browser.
 */
export const TOOL_USER_AGENT_PREFIXES = [
  'python',
  'aiohttp',
  'httpx',
  'scrapy',
  'curl',
  'wget',
  'httpie',
  'go-http-client',
  'axios',
  'node-fetch',
  'node',
  'undici',
  'got',
  'deno',
  'bun',
  'okhttp',
  'java',
  'apache-httpclient',
  'libwww-perl',
  'lwp',
  'ruby',
  'faraday',
  'php',
  'guzzlehttp',
  'dart',
  'reqwest',
  'postmanruntime',
  'insomnia',
] as const;

const TOOL_USER_AGENT_PATTERN = new RegExp(
  `^(?:${TOOL_USER_AGENT_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join(
    '|'
  )})\\b`,
  'i'
);

/** The tRPC context fields the classifier reads. All optional: a server-side caller sets fewer. */
export type TrpcCallerInput = {
  /** `null` only on server-side prefetch contexts (`createServerSideHelpers`), see below. */
  cache?: unknown;
  apiKeyId?: number | null;
  subject?: unknown;
  user?: unknown;
  bannedUser?: unknown;
  userAgent?: string | string[] | null;
};

/**
 * The caller class of one tRPC procedure call. Pure, total, and always one of TRPC_CALLER_CLASSES.
 *
 * Order matters:
 *  1. `internal`: the app calling its own procedures during a server render. The server-side
 *     helpers build their context with `cache: null`, and that is the only context that does
 *     (the HTTP route always sets a cache object; `edgeCacheIt` relies on the same signal).
 *  2. `api_key`: a bearer API key or OAuth token. Checked BEFORE the session, because token auth
 *     also resolves a user.
 *  3. `session`: a signed-in user (a banned account included: it is still signed in).
 *  4. Anonymous: `anon_tool_ua` for a missing or blank user agent or one starting with a known
 *     tool/library token, otherwise `anon_browser`.
 */
export function classifyTrpcCaller(input: TrpcCallerInput): TrpcCallerClass {
  if (input.cache === null) return 'internal';
  if (input.apiKeyId != null || input.subject != null) return 'api_key';
  if (input.user || input.bannedUser) return 'session';
  const raw = input.userAgent;
  const ua = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (typeof ua !== 'string') return 'anon_tool_ua';
  const trimmed = ua.trimStart();
  if (trimmed.length === 0 || TOOL_USER_AGENT_PATTERN.test(trimmed)) return 'anon_tool_ua';
  return 'anon_browser';
}

type CallerLabels = { path: string; caller: TrpcCallerClass };

/** Calls and seconds recorded since the last scrape, for one (path, caller) pair. */
type Cell = { labels: CallerLabels; calls: number; seconds: number };

type Pending = Map<string, Partial<Record<TrpcCallerClass, Cell>>>;

declare global {
  // eslint-disable-next-line no-var
  var __civitaiTrpcCallerPending: Pending | undefined;
}

// Pending deltas, keyed path -> caller. Bounded by (paths x 5): the same pairs the counters hold.
// Pinned on globalThis for the same reason as `instrumentationRegistry`: the counters are created
// once per process, so their `collect` must drain the map every webpack graph (and every HMR
// re-evaluation) of this module records into, not only the one that created them.
const pending: Pending = (globalThis.__civitaiTrpcCallerPending ??= new Map());

// Each counter drains its own field of every cell when it is read (prom-client calls `collect`
// from `get()`, i.e. on every scrape), so a scrape always exports every call recorded before it.
function drainCalls(this: Counter<'path' | 'caller'>) {
  for (const byCaller of pending.values()) {
    for (const cell of Object.values(byCaller)) {
      if (cell && cell.calls > 0) {
        this.inc(cell.labels, cell.calls);
        cell.calls = 0;
      }
    }
  }
}

function drainSeconds(this: Counter<'path' | 'caller'>) {
  for (const byCaller of pending.values()) {
    for (const cell of Object.values(byCaller)) {
      if (cell && cell.seconds > 0) {
        this.inc(cell.labels, cell.seconds);
        cell.seconds = 0;
      }
    }
  }
}

function ensureCounters() {
  registerInstrumentationMetric(
    TRPC_CALLER_TOTAL_METRIC,
    () =>
      new client.Counter({
        name: TRPC_CALLER_TOTAL_METRIC,
        help: 'tRPC procedure calls by procedure path and caller class (session, api_key, anon_browser, anon_tool_ua, internal). `path` matches civitai_app_trpc_procedure_duration_seconds.',
        labelNames: ['path', 'caller'] as const,
        registers: [instrumentationRegistry],
        collect: drainCalls,
      })
  );
  registerInstrumentationMetric(
    TRPC_CALLER_SECONDS_METRIC,
    () =>
      new client.Counter({
        name: TRPC_CALLER_SECONDS_METRIC,
        help: 'Wall-clock seconds spent in tRPC procedures (full chain + resolver) by procedure path and caller class. Divide by civitai_app_trpc_caller_total for the mean.',
        labelNames: ['path', 'caller'] as const,
        registers: [instrumentationRegistry],
        collect: drainSeconds,
      })
  );
}

// Registered at import so both series families exist on the first scrape.
try {
  ensureCounters();
} catch {
  // A registration failure must not break the module that imports this one.
}

/** One call: +1 call and +`seconds` for (path, caller), exported on the next scrape. Never throws. */
export function recordTrpcCaller(path: string, caller: TrpcCallerClass, seconds: number) {
  try {
    let byCaller = pending.get(path);
    if (!byCaller) {
      byCaller = {};
      pending.set(path, byCaller);
    }
    let cell = byCaller[caller];
    if (!cell) {
      cell = { labels: { path, caller }, calls: 0, seconds: 0 };
      byCaller[caller] = cell;
    }
    cell.calls += 1;
    // A counter rejects a negative or non-finite increment; a clock that went backwards loses
    // only this call's seconds, not its count.
    if (seconds > 0 && seconds !== Infinity) cell.seconds += seconds;
  } catch {
    // Losing one increment is fine.
  }
}

/** `classifyTrpcCaller` that never throws: a context it cannot read counts as `anon_tool_ua`. */
export function safeClassifyTrpcCaller(input: TrpcCallerInput): TrpcCallerClass {
  try {
    return classifyTrpcCaller(input);
  } catch {
    return 'anon_tool_ua';
  }
}
