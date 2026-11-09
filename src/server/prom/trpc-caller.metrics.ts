import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';

// tRPC caller class: who spends procedure time, by path.
//
// One counter, recorded once per procedure call with the same `path` value as the duration
// histogram (`civitai_app_trpc_procedure_duration_seconds`), so the two join on `path` where
// TRPC_PROCEDURE_METRICS is also on (the histogram has its own switch):
//   - `civitai_app_trpc_caller_seconds_total{path,caller}`: wall-clock seconds those calls took.
// No buckets and no per-call count: the histogram carries the latency shape and the call count by
// path; this only splits the time by caller class, at one series per (path, caller).

// CARDINALITY: `caller` takes exactly the five values in TRPC_CALLER_CLASSES, never anything
// derived from the request. A user agent is matched against a fixed token list and only the
// resulting class is a label. `path` is the procedure name, the same bounded set as the histogram.
//
// SPOOFABLE: `anon_browser` vs `anon_tool_ua` comes from the user agent, which the caller chooses.
// A tool that sends a browser user agent counts as `anon_browser`, so `anon_tool_ua` is a lower
// bound on scripted anonymous traffic, never an identification of bots. `session`, `api_key` and
// `internal` come from the resolved credential and the server-side context, not from a header.
//
// HOT PATH: one anchored regex test on the user agent (anonymous callers only) and one number
// addition per call. A prom-client `inc` hashes and validates labels on every call, so seconds
// accumulate in plain per-(path, caller) cells and are folded into the counter by its own
// `collect`, which prom-client runs on every scrape. A call allocates nothing after
// the first one for its pair.

export const TRPC_CALLER_SECONDS_METRIC = PROM_PREFIX + 'trpc_caller_seconds_total';

/** The one switch for this metric, read once at load. The tRPC middleware reads it from here. */
export const TRPC_CALLER_METRICS_ENABLED = process.env.TRPC_CALLER_METRICS === 'true';

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
  /**
   * `null` on server-side prefetch contexts (`createServerSideHelpers`) and on contexts built by
   * hand with `cache: null` (`api/v1/blocks/tip.ts`); both count as `internal`, see below.
   */
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
 *  1. `internal`: any context with `cache: null`. The server-side helpers build theirs that way
 *     for a server render, and so does the hand-built context in `api/v1/blocks/tip.ts`, so that
 *     API route's calls also count as `internal`. The HTTP tRPC route always sets a cache object
 *     (`edgeCacheIt` relies on the same signal).
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

/** Seconds recorded since the last scrape, for one (path, caller) pair. */
type Cell = { labels: CallerLabels; seconds: number };

type Pending = Map<string, Partial<Record<TrpcCallerClass, Cell>>>;

declare global {
  // eslint-disable-next-line no-var
  var __civitaiTrpcCallerPending: Pending | undefined;
}

// Pending seconds, keyed path -> caller; bounded by (paths x 5), the pairs the counter holds.
// Pinned on globalThis for the same reason as `instrumentationRegistry`: the counter is created
// once per process, so its `collect` must drain the map every webpack graph (and every HMR
// re-evaluation) of this module records into, not only the one that created them.
const pending: Pending = (globalThis.__civitaiTrpcCallerPending ??= new Map());

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

function registerCounter() {
  registerInstrumentationMetric(
    TRPC_CALLER_SECONDS_METRIC,
    () =>
      new client.Counter({
        name: TRPC_CALLER_SECONDS_METRIC,
        help: 'Wall-clock seconds spent in tRPC procedures (full chain + resolver) by procedure path and caller class. Where TRPC_PROCEDURE_METRICS is also on, divide by civitai_app_trpc_procedure_duration_seconds_count for a path to get its mean per call.',
        labelNames: ['path', 'caller'] as const,
        registers: [instrumentationRegistry],
        collect: drainSeconds,
      })
  );
}

// Registered at import, and only when switched on, so the family exists on the first scrape.
if (TRPC_CALLER_METRICS_ENABLED) {
  try {
    registerCounter();
  } catch {
    // A registration failure must not break the module that imports this one.
  }
}

/** One call: +`seconds` for (path, caller), exported on the next scrape. Never throws. */
export function recordTrpcCaller(path: string, caller: TrpcCallerClass, seconds: number) {
  try {
    let byCaller = pending.get(path);
    if (!byCaller) {
      byCaller = {};
      pending.set(path, byCaller);
    }
    let cell = byCaller[caller];
    if (!cell) {
      cell = { labels: { path, caller }, seconds: 0 };
      byCaller[caller] = cell;
    }
    // A counter rejects a negative or non-finite increment; such a duration is dropped.
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
