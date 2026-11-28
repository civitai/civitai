import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import {
  BEACON_GO_SHADOW_ENDPOINTS,
  recordBeaconGoShadowOutcome,
  type BeaconGoShadowEndpoint,
  type BeaconGoShadowOutcome,
} from '~/server/prom/beacon-go-shadow.metrics';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';
import { createPerSecondBuckets, envNumber } from '~/server/utils/shadow-sampler';
import {
  buildBeaconGoShadowPayload,
  pickBeaconResponseHeaders,
  pickBeaconShadowHeaders,
  shadowBody,
  type ResponseHeadersLike,
  type ShadowRequestLike,
} from './beacon-go-shadow-payload';

/**
 * Shadow sampler for the Go beacon service (apps/beacon-go, see its DESIGN.md): after Node has
 * answered a sampled `/api/internal/ping`, `/api/internal/pulse` or `/api/track/batch` request, post
 * what Node saw, what it answered AND the tracker rows it wrote to that service's internal compare
 * endpoint, which recomputes all three and compares them byte for byte. Node keeps serving and
 * writing every request; beacon-go writes nothing in this mode.
 *
 * Off unless ALL of these hold: `BEACON_GO_SHADOW_URL` is set; the endpoint's rate is > 0
 * (`BEACON_GO_SHADOW_SAMPLE_RATE` for ping and pulse, `BEACON_GO_SHADOW_TRACK_BATCH_SAMPLE_RATE` for
 * track-batch, each default 0, so turning on the beacons' shadow leaves track-batch off); the Tracker
 * would actually send (otherwise Node writes nothing and there is no row to compare); the
 * `beacon-go-shadow` Flipt flag is on (unknown or uninitialized reads as off). A
 * per-endpoint token bucket (`BEACON_GO_SHADOW_MAX_PER_SECOND`) and a shared in-flight cap
 * (`BEACON_GO_SHADOW_MAX_IN_FLIGHT`) bound the work.
 *
 * What is captured, and when:
 * - the response: status and the endpoint-decided headers at `finish`, and the body from the
 *   handler's `res.end` (wrapped for the sampled request only);
 * - the writes: each row `Tracker.send` dispatches (`Tracker.onSend`), as `JSON.stringify(row)`,
 *   the bytes it POSTs. /pulse does not await its view, so the sample is sent only once the
 *   response has finished AND the view's promise (`waitFor`) has settled.
 *
 * Forwarded: the headers the outcome depends on (including the client-ip chain and the user agent,
 * which land in the rows), the SESSION cookies only (beacon-go re-verifies their signature), and an
 * Authorization header only as the literal `present`.
 *
 * 🔴 The forwarded session cookie is a bearer credential and the forwarded headers carry the
 * caller's address: `BEACON_GO_SHADOW_URL` must be an in-cluster address, never a public hostname.
 */

/** beacon-go's compare path is this prefix + the endpoint's public route (internal/server ShadowPath). */
export const BEACON_GO_SHADOW_PATH_PREFIX = '/internal/shadow';

/** Each endpoint's public route (beacon-go internal/server Routes). */
export const BEACON_GO_SHADOW_ROUTES: Record<BeaconGoShadowEndpoint, string> = {
  ping: '/api/internal/ping',
  pulse: '/api/internal/pulse',
  'track-batch': '/api/track/batch',
};

export const BEACON_GO_SHADOW_DEFAULT_TIMEOUT_MS = 2_000;
export const BEACON_GO_SHADOW_MAX_TIMEOUT_MS = 10_000;
export const BEACON_GO_SHADOW_DEFAULT_MAX_IN_FLIGHT = 16;
export const BEACON_GO_SHADOW_DEFAULT_MAX_PER_SECOND = 20;

export type BeaconGoShadowConfig = {
  /** Base of beacon-go's internal listener (scheme + host + port), or undefined (disabled). */
  base: string | undefined;
  /** ping and pulse. */
  rate: number;
  /** track-batch, on its own so the beacons' shadow does not turn it on. */
  trackBatchRate: number;
  timeoutMs: number;
  maxInFlight: number;
  maxPerSecond: number;
};

type Env = Record<string, string | undefined>;

/** Parse the env. A `BEACON_GO_SHADOW_URL` that is not an http(s) URL disables the sampler. */
export function readBeaconGoShadowConfig(env: Env = process.env): BeaconGoShadowConfig {
  let base: string | undefined;
  const raw = env.BEACON_GO_SHADOW_URL?.trim();
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') base = parsed.toString();
    } catch {
      base = undefined;
    }
  }
  return {
    base,
    rate: envNumber(env.BEACON_GO_SHADOW_SAMPLE_RATE, 0, 0, 1),
    trackBatchRate: envNumber(env.BEACON_GO_SHADOW_TRACK_BATCH_SAMPLE_RATE, 0, 0, 1),
    timeoutMs: Math.round(
      envNumber(
        env.BEACON_GO_SHADOW_TIMEOUT_MS,
        BEACON_GO_SHADOW_DEFAULT_TIMEOUT_MS,
        1,
        BEACON_GO_SHADOW_MAX_TIMEOUT_MS
      )
    ),
    maxInFlight: Math.floor(
      envNumber(env.BEACON_GO_SHADOW_MAX_IN_FLIGHT, BEACON_GO_SHADOW_DEFAULT_MAX_IN_FLIGHT, 1, 256)
    ),
    maxPerSecond: envNumber(
      env.BEACON_GO_SHADOW_MAX_PER_SECOND,
      BEACON_GO_SHADOW_DEFAULT_MAX_PER_SECOND,
      0.1,
      1000
    ),
  };
}

/** The compare endpoint for one beacon. */
export function beaconGoShadowUrl(base: string, endpoint: BeaconGoShadowEndpoint): string {
  return new URL(
    `${BEACON_GO_SHADOW_PATH_PREFIX}${BEACON_GO_SHADOW_ROUTES[endpoint]}`,
    base
  ).toString();
}

type ResponseLike = ResponseHeadersLike & {
  statusCode: number;
  end: (...args: any[]) => unknown;
  once(event: 'finish' | 'close', fn: () => void): unknown;
};

export type BeaconGoShadowSample = {
  endpoint: BeaconGoShadowEndpoint;
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string;
  bodyIsString: boolean;
  responseBody: string;
  writes: { table: string; body: string }[];
  pending: Promise<unknown>[];
  done: boolean;
};

export type BeaconGoShadowDeps = {
  config: BeaconGoShadowConfig;
  /** The `beacon-go-shadow` flag. */
  enabled: () => boolean;
  /** Whether the Tracker would send (CLICKHOUSE_TRACKER_URL set, outward traffic allowed). */
  trackerSends: () => boolean;
  random?: () => number;
  fetch?: typeof fetch;
  record?: (outcome: BeaconGoShadowOutcome, endpoint: BeaconGoShadowEndpoint) => void;
  /** Milliseconds clock for the per-second budget (production: `performance.now`). */
  now?: () => number;
};

/** A sampler instance. The module exports one wired to the env, the flag and the counter. */
export function createBeaconGoShadow(deps: BeaconGoShadowDeps) {
  const { config, enabled, trackerSends } = deps;
  const random = deps.random ?? Math.random;
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const record = deps.record ?? recordBeaconGoShadowOutcome;
  const now = deps.now ?? (() => performance.now());
  let inFlight = 0;
  // One bucket per endpoint, so a busy beacon cannot starve the other.
  const buckets = createPerSecondBuckets(BEACON_GO_SHADOW_ENDPOINTS, config.maxPerSecond, now);

  function release(sample: BeaconGoShadowSample) {
    if (sample.done) return;
    sample.done = true;
    inFlight--;
  }

  function send(sample: BeaconGoShadowSample, res: ResponseLike) {
    let body: string;
    try {
      body = buildBeaconGoShadowPayload({
        method: sample.method,
        target: sample.target,
        headers: sample.headers,
        body: sample.body,
        bodyIsString: sample.bodyIsString,
        status: res.statusCode,
        responseHeaders: pickBeaconResponseHeaders(res),
        responseBody: sample.responseBody,
        writes: sample.writes,
      });
    } catch {
      record('skipped_encode', sample.endpoint);
      release(sample);
      return;
    }
    let pending: Promise<Response>;
    try {
      pending = doFetch(beaconGoShadowUrl(config.base!, sample.endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      record('error', sample.endpoint);
      release(sample);
      return;
    }
    pending
      .then(
        (r) => {
          record(r.ok ? 'sent' : 'rejected', sample.endpoint);
          r.body?.cancel().catch(() => undefined);
        },
        (err: unknown) => {
          const name = (err as { name?: string } | undefined)?.name;
          record(
            name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error',
            sample.endpoint
          );
        }
      )
      .catch(() => undefined)
      .finally(() => release(sample));
  }

  /**
   * Decide whether this request is sampled; when it is, wrap `res.end` to capture the body and
   * arrange the send for after `finish`. Never throws.
   */
  function begin(
    req: ShadowRequestLike,
    res: ResponseLike,
    endpoint: BeaconGoShadowEndpoint
  ): BeaconGoShadowSample | undefined {
    try {
      const rate = endpoint === 'track-batch' ? config.trackBatchRate : config.rate;
      if (!config.base || rate <= 0) return undefined;
      if (!trackerSends()) return undefined;
      if (!enabled()) return undefined;
      if (random() >= rate) return undefined;
      if (inFlight >= config.maxInFlight) {
        record('dropped_overload', endpoint);
        return undefined;
      }
      if (!buckets.take(endpoint)) {
        record('dropped_rate_limit', endpoint);
        return undefined;
      }
      const { body, bodyIsString } = shadowBody(req.body);
      const sample: BeaconGoShadowSample = {
        endpoint,
        method: req.method ?? 'GET',
        // Held in memory only: the payload builder sends the path and a query marker (shadowTarget),
        // never the query, which can hold an API key.
        target: req.url ?? '',
        headers: pickBeaconShadowHeaders(req),
        body,
        bodyIsString,
        responseBody: '',
        writes: [],
        pending: [],
        done: false,
      };
      inFlight++;
      const end = res.end;
      res.end = function (this: unknown, ...args: any[]) {
        try {
          const chunk = args[0];
          if (typeof chunk === 'string') sample.responseBody = chunk;
          else if (Buffer.isBuffer(chunk)) sample.responseBody = chunk.toString('utf8');
        } catch {
          /* never throw from the response path */
        }
        return end.apply(this, args);
      };
      let finished = false;
      res.once('finish', () => {
        finished = true;
        void Promise.allSettled(sample.pending).then(() => send(sample, res));
      });
      // A client that went away: nothing complete to compare.
      res.once('close', () => {
        if (!finished) release(sample);
      });
      return sample;
    } catch {
      return undefined;
    }
  }

  /** `Tracker.onSend` for a sampled request: keep the row as the bytes the Tracker POSTs. */
  function captureWrite(sample: BeaconGoShadowSample, table: string, row: object) {
    try {
      if (sample.done) return;
      sample.writes.push({ table, body: JSON.stringify(row) });
    } catch {
      /* never throw from the tracker */
    }
  }

  /** Hold the send until `promise` (an un-awaited tracker call) settles. */
  function waitFor(sample: BeaconGoShadowSample, promise: Promise<unknown>) {
    sample.pending.push(promise.catch(() => undefined));
  }

  return { begin, captureWrite, waitFor, inFlight: () => inFlight };
}

export type BeaconGoShadow = ReturnType<typeof createBeaconGoShadow>;

let instance: BeaconGoShadow | undefined;

function getInstance(trackerSends: () => boolean): BeaconGoShadow {
  instance ??= createBeaconGoShadow({
    config: readBeaconGoShadowConfig(),
    enabled: createCachedFlagGate(readFliptSwitch(() => FLIPT_FEATURE_FLAGS.BEACON_GO_SHADOW)),
    trackerSends,
  });
  return instance;
}

/** Tests only: rebuild the process instance from the current env on next use. */
export function resetBeaconGoShadowForTests() {
  instance = undefined;
}

/** What a handler holds for a sampled request. */
export type BeaconGoShadowHandle = {
  /** Capture every row this Tracker sends. */
  attach(tracker: { onSend?: (table: string, row: object) => void }): void;
  /** Hold the send until an un-awaited tracker call settles. */
  waitFor(promise: Promise<unknown>): void;
};

/**
 * The beacon handlers' entry point, called first thing in the handler: begin a sample (or not).
 * `trackerSends` is the Tracker's own send precondition. Never throws.
 */
export function beginBeaconGoShadow(
  req: ShadowRequestLike,
  res: ResponseLike,
  endpoint: BeaconGoShadowEndpoint,
  trackerSends: () => boolean
): BeaconGoShadowHandle | undefined {
  try {
    const owner = getInstance(trackerSends);
    const sample = owner.begin(req, res, endpoint);
    if (!sample) return undefined;
    return {
      attach: (tracker) => {
        tracker.onSend = (table, row) => owner.captureWrite(sample, table, row);
      },
      waitFor: (p) => owner.waitFor(sample, p),
    };
  } catch {
    return undefined;
  }
}
