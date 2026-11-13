import { AsyncLocalStorage } from 'node:async_hooks';
import superjson from 'superjson';
import {
  HOST_COOKIE_PREFIX,
  SECURE_COOKIE_PREFIX,
  SESSION_COOKIE_BASE,
} from '@civitai/auth/client';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import {
  recordFeedGoShadowOutcome,
  type FeedGoShadowOutcome,
} from '~/server/prom/feed-go-shadow.metrics';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * Shadow sampler for `apps/feed-go` (the Go port of `image.getImagesAsPostsInfinite`, see
 * `apps/feed-go/DESIGN.md` §7). After Node has answered a sampled request, this mirrors what Node
 * saw and what it answered to feed-go's internal compare endpoint, which recomputes the answer and
 * counts the differences. Node keeps serving every request; feed-go's answer is never used.
 *
 * Off unless ALL of these hold:
 *  1. `FEED_GO_SHADOW_URL` is set (feed-go's internal listener, e.g. `http://<service>:9090`);
 *  2. `FEED_GO_SHADOW_SAMPLE_RATE` is > 0 (a fraction, 0..1);
 *  3. the `feed-go-shadow` Flipt flag is on (global boolean, read at most once per 5s per process;
 *     unknown flag or uninitialized client reads as off).
 *
 * The user's request is never slowed or failed by it:
 *  - the sample decision is a few property reads, a cached flag read and one `Math.random()`;
 *  - the response body is captured at serialize time by REFERENCE (the superjson envelope Node
 *    already built for the wire); nothing is copied or encoded on the request path;
 *  - the payload is encoded and POSTed from `setImmediate`, after the handler has written the
 *    response, never awaited, with a tight timeout (`FEED_GO_SHADOW_TIMEOUT_MS`);
 *  - at most `FEED_GO_SHADOW_MAX_IN_FLIGHT` samples per process are in flight; a sample beyond
 *    that is dropped at decision time (`dropped_overload`), before anything is captured;
 *  - every failure is swallowed into `civitai_app_feed_go_shadow_samples_total{outcome}`.
 *
 * What is forwarded is only what feed-go's answer depends on: the raw `input` query value, the
 * `host`, the country / region / UK headers, the verified-crawler header, whether the request
 * carried an API credential (as the literal `present`, never the credential), and the SESSION
 * cookies only (other cookies are dropped). feed-go re-verifies the session cookie's signature
 * itself; it never trusts an identity asserted by the caller.
 *
 * 🔴 The forwarded session cookie is a bearer credential. `FEED_GO_SHADOW_URL` must point at an
 * in-cluster address only (plain HTTP inside the cluster network, reachable only from the web
 * pods); never at a public hostname.
 */

export const FEED_GO_SHADOW_PROCEDURE = 'image.getImagesAsPostsInfinite';
export const FEED_GO_SHADOW_PATH = `/internal/shadow/${FEED_GO_SHADOW_PROCEDURE}`;

export const SHADOW_DEFAULT_TIMEOUT_MS = 2_000;
export const SHADOW_MAX_TIMEOUT_MS = 10_000;
export const SHADOW_DEFAULT_MAX_IN_FLIGHT = 8;

/** The session cookie names feed-go reads (dev, `__Secure-` and `__Host-` slots). */
const SESSION_COOKIE_NAMES = new Set([
  SESSION_COOKIE_BASE,
  `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_BASE}`,
  `${HOST_COOKIE_PREFIX}${SESSION_COOKIE_BASE}`,
]);

/** Headers forwarded verbatim when present. */
const COPIED_HEADERS = [
  'host',
  'cf-ipcountry',
  'cf-region-code',
  'x-isuk',
  'x-civitai-verified-bot',
] as const;

export type FeedGoShadowConfig = {
  /** Full compare endpoint URL, or undefined (disabled). */
  url: string | undefined;
  rate: number;
  timeoutMs: number;
  maxInFlight: number;
};

type Env = Record<string, string | undefined>;

function envNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse the env. `FEED_GO_SHADOW_URL` is the BASE of feed-go's internal listener (scheme + host +
 * port); the compare path is appended. A value that is not an http(s) URL disables the sampler.
 */
export function readFeedGoShadowConfig(env: Env = process.env): FeedGoShadowConfig {
  let url: string | undefined;
  const base = env.FEED_GO_SHADOW_URL?.trim();
  if (base) {
    try {
      const parsed = new URL(base);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        url = new URL(FEED_GO_SHADOW_PATH, parsed).toString();
      }
    } catch {
      url = undefined;
    }
  }
  return {
    url,
    rate: envNumber(env.FEED_GO_SHADOW_SAMPLE_RATE, 0, 0, 1),
    timeoutMs: Math.round(
      envNumber(env.FEED_GO_SHADOW_TIMEOUT_MS, SHADOW_DEFAULT_TIMEOUT_MS, 1, SHADOW_MAX_TIMEOUT_MS)
    ),
    maxInFlight: Math.floor(
      envNumber(env.FEED_GO_SHADOW_MAX_IN_FLIGHT, SHADOW_DEFAULT_MAX_IN_FLIGHT, 1, 256)
    ),
  };
}

/** Keep only the session cookies of a raw `Cookie` header (same `name=value` text, `; `-joined). */
export function pickSessionCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept: string[] = [];
  for (const part of header.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (SESSION_COOKIE_NAMES.has(pair.slice(0, eq).trim())) kept.push(pair);
  }
  return kept.length ? kept.join('; ') : undefined;
}

type ShadowRequestLike = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Partial<Record<string, string | string[]>>;
};

function headerValue(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return undefined;
}

/** The headers feed-go needs, and nothing else (see the module doc). */
export function pickShadowHeaders(req: ShadowRequestLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of COPIED_HEADERS) {
    const v = headerValue(req.headers[name]);
    if (v) out[name] = v;
  }
  const cookie = pickSessionCookies(headerValue(req.headers.cookie));
  if (cookie) out.cookie = cookie;
  // feed-go falls back on ANY API credential (bearer header or `?token=`); only presence matters,
  // so the credential itself is never forwarded.
  if (headerValue(req.headers.authorization) || req.query.token !== undefined)
    out.authorization = 'present';
  return out;
}

type Captured = { envelope: unknown } | { data: unknown };

export type FeedGoShadowSample = {
  input: string;
  headers: Record<string, string>;
  captured?: Captured;
  done: boolean;
};

export type FeedGoShadowDeps = {
  config: FeedGoShadowConfig;
  /** The `feed-go-shadow` flag. */
  enabled: () => boolean;
  random?: () => number;
  fetch?: typeof fetch;
  record?: (outcome: FeedGoShadowOutcome) => void;
  /** Runs the send after the request (production: `setImmediate`). */
  schedule?: (fn: () => void) => void;
};

/** A sampler instance. The module exports one wired to the env, the flag and the counter. */
export function createFeedGoShadow(deps: FeedGoShadowDeps) {
  const { config, enabled } = deps;
  const random = deps.random ?? Math.random;
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const record = deps.record ?? recordFeedGoShadowOutcome;
  const schedule = deps.schedule ?? ((fn: () => void) => void setImmediate(fn));
  const storage = new AsyncLocalStorage<FeedGoShadowSample>();
  let inFlight = 0;

  function release(sample: FeedGoShadowSample) {
    if (sample.done) return;
    sample.done = true;
    inFlight--;
  }

  /**
   * Decide whether this request is sampled. Returns the sample (holding one in-flight slot until
   * `finish` / the POST settles) or undefined. Never throws.
   */
  function begin(req: ShadowRequestLike): FeedGoShadowSample | undefined {
    try {
      if (!config.url || config.rate <= 0) return undefined;
      if ((req.method ?? '').toUpperCase() !== 'GET') return undefined;
      // Exactly this one procedure, unbatched (the web client never batches it).
      if (req.query.trpc !== FEED_GO_SHADOW_PROCEDURE || req.query.batch !== undefined)
        return undefined;
      const input = req.query.input;
      if (input !== undefined && typeof input !== 'string') return undefined;
      if (!enabled()) return undefined;
      if (random() >= config.rate) return undefined;
      if (inFlight >= config.maxInFlight) {
        record('dropped_overload');
        return undefined;
      }
      const headers = pickShadowHeaders(req);
      inFlight++;
      return { input: input ?? '', headers, done: false };
    } catch {
      return undefined;
    }
  }

  /** Run the tRPC handler with the sample in scope, so the serializer can capture its output. */
  function run<T>(sample: FeedGoShadowSample | undefined, fn: () => T): T {
    return sample ? storage.run(sample, fn) : fn();
  }

  /**
   * Called by the server transformer with the payload and what it wrote. Keeps a REFERENCE only:
   * the superjson envelope when one was written, else the payload (a devalue response), which is
   * superjson-encoded later, off the request path. First call wins (one unbatched call serializes
   * one result). Costs one integer compare when no sample is in flight anywhere in the process.
   */
  function capture(data: unknown, written: unknown, wroteDevalue: boolean): void {
    if (inFlight === 0) return;
    try {
      const sample = storage.getStore();
      if (!sample || sample.captured || sample.done) return;
      sample.captured = wroteDevalue ? { data } : { envelope: written };
    } catch {
      /* never throw from the serializer */
    }
  }

  function send(sample: FeedGoShadowSample): void {
    let body: string;
    try {
      const captured = sample.captured!;
      const node = 'envelope' in captured ? captured.envelope : superjson.serialize(captured.data);
      body = JSON.stringify({ input: sample.input, headers: sample.headers, node });
    } catch {
      record('skipped_encode');
      release(sample);
      return;
    }
    let pending: Promise<Response>;
    try {
      pending = doFetch(config.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      record('error');
      release(sample);
      return;
    }
    pending
      .then(
        (res) => {
          record(res.ok ? 'sent' : 'rejected');
          // Free the connection; feed-go's 202 has no body worth reading.
          res.body?.cancel().catch(() => undefined);
        },
        (err: unknown) => {
          const name = (err as { name?: string } | undefined)?.name;
          record(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error');
        }
      )
      .catch(() => undefined)
      .finally(() => release(sample));
  }

  /**
   * After the handler: queue the POST if Node answered 200 and a body was captured. Synchronous,
   * returns nothing to await, never throws.
   */
  function finish(sample: FeedGoShadowSample, statusCode: number): void {
    try {
      if (sample.done) return;
      if (statusCode !== 200) {
        record('skipped_status');
        release(sample);
        return;
      }
      if (!sample.captured) {
        record('skipped_no_capture');
        release(sample);
        return;
      }
      schedule(() => send(sample));
    } catch {
      release(sample);
    }
  }

  return { begin, run, capture, finish, inFlight: () => inFlight };
}

export type FeedGoShadow = ReturnType<typeof createFeedGoShadow>;

let instance: FeedGoShadow | undefined;

function getInstance(): FeedGoShadow {
  instance ??= createFeedGoShadow({
    config: readFeedGoShadowConfig(),
    enabled: createCachedFlagGate(readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW)),
  });
  return instance;
}

/** Tests only: rebuild the process instance from the current env on next use. */
export function resetFeedGoShadowForTests() {
  instance = undefined;
}

/** The instance that began each sample, so its run / finish reach the same in-flight count. */
const owners = new WeakMap<FeedGoShadowSample, FeedGoShadow>();

export function beginFeedGoShadow(req: ShadowRequestLike): FeedGoShadowSample | undefined {
  const owner = getInstance();
  const sample = owner.begin(req);
  if (sample) owners.set(sample, owner);
  return sample;
}

export function runWithFeedGoShadow<T>(sample: FeedGoShadowSample | undefined, fn: () => T): T {
  if (!sample) return fn();
  return (owners.get(sample) ?? getInstance()).run(sample, fn);
}

export function captureFeedGoShadowResponse(data: unknown, written: unknown, devalue: boolean) {
  getInstance().capture(data, written, devalue);
}

export function finishFeedGoShadow(sample: FeedGoShadowSample, statusCode: number): void {
  (owners.get(sample) ?? getInstance()).finish(sample, statusCode);
}
