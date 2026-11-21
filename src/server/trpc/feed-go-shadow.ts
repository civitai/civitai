import { AsyncLocalStorage } from 'node:async_hooks';
import superjson from 'superjson';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { imagesEndpointSchema } from '~/server/schema/images-endpoint.schema';
import {
  FEED_GO_SHADOW_ENDPOINTS,
  recordFeedGoProbeOutcome,
  recordFeedGoShadowEncode,
  recordFeedGoShadowOutcome,
  type FeedGoProbeOutcome,
  type FeedGoShadowEndpoint,
  type FeedGoShadowOutcome,
  type FeedGoV1ShapeClass,
} from '~/server/prom/feed-go-shadow.metrics';
import { pickSessionCookies } from '~/server/utils/session-cookies';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';
import { createPerSecondBuckets, envNumber } from '~/server/utils/shadow-sampler';

/**
 * Shadow sampler for the Go feed service (see its DESIGN.md): after Node has answered a sampled
 * request, mirror what Node saw and what it answered to that service's internal compare endpoint.
 * Node keeps serving every request. Each mirrored route is behind its own flag:
 *
 * - `image.getImagesAsPostsInfinite` (tRPC; flag `feed-go-shadow`): the raw `input` and the
 *   superjson envelope the transformer wrote, captured in an AsyncLocalStorage scope;
 * - `image.getInfinite` (tRPC; flag `feed-go-shadow-infinite`): the same capture, posted to its
 *   own compare path (`feed_endpoint="infinite"`);
 * - `model.getAll` (tRPC; flag `feed-go-shadow-model-getall`): the same capture, posted to its own
 *   compare path (`feed_endpoint="model-getall"`);
 * - `model.getAssociatedResourcesCardData` (tRPC; flag `feed-go-shadow-model-associated`): the same
 *   capture, posted to its own compare path (`feed_endpoint="model-associated"`). A signed-in browser
 *   batches it when `trpcBatching` is on for that user, and a batched call is never sampled;
 * - `image.getPublishedWithApp` (tRPC; flag `feed-go-shadow-image-published-app`): the same capture,
 *   posted to its own compare path (`feed_endpoint="image-published-app"`). A signed-in browser
 *   batches it when `trpcBatching` is on for that user, so it too is sampled for anonymous sessions
 *   and for signed-in sessions with batching off only;
 * - the REST routes, `GET /api/v1/images` (flag `feed-go-shadow-v1-images`) and
 *   `GET /api/v1/models` + `GET /api/v1/models/[id]` (one flag, `feed-go-shadow-v1-models`): the raw
 *   query string, the path and the JSON body the handler passed to `res.json`, captured by the
 *   handler itself. A request carrying an API credential is not mirrored (`skipped_credential`):
 *   the body can echo it.
 *
 * Off unless ALL of these hold: `FEED_GO_SHADOW_URL` is set; `FEED_GO_SHADOW_SAMPLE_RATE` is > 0;
 * the route's Flipt flag is on (unknown or uninitialized reads as off). Every route shares the
 * sample rate and the in-flight cap; each has its own per-second bucket of the same size, so one
 * route cannot drain another's tokens. A REST sample takes its in-flight slot and its token
 * only once the handler has answered 200 (in `finish`): it holds nothing while it runs.
 *
 * Why the per-second token bucket (`FEED_GO_SHADOW_MAX_PER_SECOND`): the send happens after the
 * response, but encoding the page (`JSON.stringify`, plus `superjson.serialize` for a devalue
 * response) is synchronous on the event loop every other request shares, and the in-flight cap
 * does not bound it (a slot frees as soon as the compare endpoint answers).
 *
 * Forwarded: the raw `input`, the headers the answer depends on, and the SESSION cookies only
 * (the compare side re-verifies their signature). An API credential is forwarded only as the
 * literal `present`, because the answer depends on whether one was sent, never on its value.
 *
 * 🔴 The forwarded session cookie is a bearer credential: `FEED_GO_SHADOW_URL` must be an
 * in-cluster address, never a public hostname.
 *
 * Go-first probe (flag `feed-go-gofirst-probe`, default off; feed-go DESIGN.md "Go-first probe"):
 * for a sampled `image.getImagesAsPostsInfinite` request, at the START of the request — before the
 * handler computes the page and fills the per-entity caches — the route posts the input, the same
 * forwarded headers and the request's start time to feed-go's `/internal/probe/<procedure>`. feed-go
 * resolves the page and checks, read-only, which caches a Go-first serve would have found cold. The
 * shadow comparison cannot see that: its sample is posted after Node has warmed those caches.
 * Fire-and-forget: the POST is started before the handler and never awaited. It runs only for a
 * request the shadow sampler already sampled (so it is inside that sample's per-second token), for
 * a further `FEED_GO_GOFIRST_PROBE_SAMPLE_RATE` fraction of them (default 0: off), takes its own
 * slot under the shared in-flight cap, and has the shadow timeout.
 */

export const FEED_GO_SHADOW_PROCEDURE = 'image.getImagesAsPostsInfinite';
export const FEED_GO_SHADOW_PATH = `/internal/shadow/${FEED_GO_SHADOW_PROCEDURE}`;
/** The second tRPC procedure mirrored under its own flag, and feed-go's compare path for it. */
export const FEED_GO_SHADOW_INFINITE_PROCEDURE = 'image.getInfinite';
export const FEED_GO_SHADOW_INFINITE_PATH = `/internal/shadow/${FEED_GO_SHADOW_INFINITE_PROCEDURE}`;
/** The REST route mirrored under its own flag, and feed-go's compare path for it. */
export const FEED_GO_SHADOW_V1_IMAGES_ROUTE = '/api/v1/images';
export const FEED_GO_SHADOW_V1_IMAGES_PATH = `/internal/shadow${FEED_GO_SHADOW_V1_IMAGES_ROUTE}`;
/** The REST model routes (one flag), and feed-go's compare paths for them. */
export const FEED_GO_SHADOW_V1_MODELS_ROUTE = '/api/v1/models';
export const FEED_GO_SHADOW_V1_MODELS_PATH = `/internal/shadow${FEED_GO_SHADOW_V1_MODELS_ROUTE}`;
export const FEED_GO_SHADOW_V1_MODELS_ID_PATH = `${FEED_GO_SHADOW_V1_MODELS_PATH}/id`;
/** The third tRPC procedure mirrored under its own flag, and feed-go's compare path for it. */
export const FEED_GO_SHADOW_MODEL_GET_ALL_PROCEDURE = 'model.getAll';
export const FEED_GO_SHADOW_MODEL_GET_ALL_PATH = `/internal/shadow/${FEED_GO_SHADOW_MODEL_GET_ALL_PROCEDURE}`;
/** The fourth tRPC procedure mirrored under its own flag, and feed-go's compare path for it. */
export const FEED_GO_SHADOW_MODEL_ASSOCIATED_PROCEDURE = 'model.getAssociatedResourcesCardData';
export const FEED_GO_SHADOW_MODEL_ASSOCIATED_PATH = `/internal/shadow/${FEED_GO_SHADOW_MODEL_ASSOCIATED_PROCEDURE}`;
/** The fifth tRPC procedure mirrored under its own flag, and feed-go's compare path for it. */
export const FEED_GO_SHADOW_IMAGE_PUBLISHED_APP_PROCEDURE = 'image.getPublishedWithApp';
export const FEED_GO_SHADOW_IMAGE_PUBLISHED_APP_PATH = `/internal/shadow/${FEED_GO_SHADOW_IMAGE_PUBLISHED_APP_PROCEDURE}`;
/** feed-go's Go-first probe path for the procedure. */
export const FEED_GO_PROBE_PATH = `/internal/probe/${FEED_GO_SHADOW_PROCEDURE}`;
/** feed-go's Go-first probe path for `image.getInfinite`. */
export const FEED_GO_PROBE_INFINITE_PATH = `/internal/probe/${FEED_GO_SHADOW_INFINITE_PROCEDURE}`;
/** feed-go's Go-first probe path for `model.getAll`. */
export const FEED_GO_PROBE_MODEL_GET_ALL_PATH = `/internal/probe/${FEED_GO_SHADOW_MODEL_GET_ALL_PROCEDURE}`;

export const SHADOW_DEFAULT_TIMEOUT_MS = 2_000;
export const SHADOW_MAX_TIMEOUT_MS = 10_000;
export const SHADOW_DEFAULT_MAX_IN_FLIGHT = 8;
export const SHADOW_DEFAULT_MAX_PER_SECOND = 5;

/** Headers forwarded verbatim when present. */
const COPIED_HEADERS = [
  'host',
  'cf-ipcountry',
  'cf-region-code',
  'x-isuk',
  'x-civitai-verified-bot',
] as const;

/**
 * The response headers mirrored with a sample, for feed-go's status + header comparison
 * (shadow.ComparedHeaders in apps/feed-go): who may cache the answer and how (Cache-Control, Vary),
 * its purge tags (Cache-Tag), whether a Set-Cookie survived (sent as the literal `present`, never
 * its value) and the stale-client signal (x-update-required). Nothing else: the payload stays bounded.
 */
export const FEED_GO_COMPARED_RESPONSE_HEADERS = [
  'cache-control',
  'vary',
  'cache-tag',
  'set-cookie',
  'x-update-required',
] as const;

/** Longest header value mirrored; a longer one is cut (a Cache-Tag list is the only one that grows). */
const RESPONSE_HEADER_MAX_CHARS = 1024;

/** A response's headers as `res.getHeaders()` returns them. */
export type ShadowResponseHeaders = Record<string, string | string[] | number | undefined>;

/** The route's response, read for its headers once the handler has answered. */
export type ShadowResponseLike = { getHeaders?: () => ShadowResponseHeaders };

/**
 * The FEED_GO_COMPARED_RESPONSE_HEADERS a response carries, lowercased, each a string (an array
 * joined with `, `, cut at RESPONSE_HEADER_MAX_CHARS); Set-Cookie as `present`. Never throws.
 */
export function pickShadowResponseHeaders(headers: ShadowResponseHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const lower: Record<string, ShadowResponseHeaders[string]> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    for (const name of FEED_GO_COMPARED_RESPONSE_HEADERS) {
      const v = lower[name];
      if (v === undefined) continue;
      const value = Array.isArray(v) ? v.join(', ') : String(v);
      // An empty value is absent, Set-Cookie included: `[]` (no cookie) must not read as present.
      if (value === '') continue;
      out[name] = name === 'set-cookie' ? 'present' : value.slice(0, RESPONSE_HEADER_MAX_CHARS);
    }
  } catch {
    /* observability only */
  }
  return out;
}

export type FeedGoShadowConfig = {
  /** Full compare endpoint URL, or undefined (disabled). */
  url: string | undefined;
  /** Full compare endpoint URL for `/api/v1/images`, or undefined (disabled). */
  v1ImagesUrl: string | undefined;
  /** Full compare endpoint URLs for `/api/v1/models` and `/api/v1/models/[id]`. */
  v1ModelsUrl: string | undefined;
  v1ModelsIdUrl: string | undefined;
  /** Full compare endpoint URL for `image.getInfinite`, or undefined (disabled). */
  infiniteUrl: string | undefined;
  /** Full compare endpoint URL for `model.getAll`, or undefined (disabled). */
  modelGetAllUrl: string | undefined;
  /** Full compare endpoint URL for `model.getAssociatedResourcesCardData`, or undefined (disabled). */
  modelAssociatedUrl: string | undefined;
  /** Full compare endpoint URL for `image.getPublishedWithApp`, or undefined (disabled). */
  imagePublishedAppUrl: string | undefined;
  rate: number;
  timeoutMs: number;
  maxInFlight: number;
  /** Samples allowed to BEGIN per second per process (token bucket, burst = one second's worth). */
  maxPerSecond: number;
  /** Full Go-first probe URL, or undefined (disabled). */
  probeUrl: string | undefined;
  /** Full Go-first probe URL for `image.getInfinite`, or undefined (disabled). */
  probeInfiniteUrl: string | undefined;
  /** Full Go-first probe URL for `model.getAll`, or undefined (disabled). */
  probeModelGetAllUrl: string | undefined;
  /** The fraction of sampled requests that are also probed (0 = none, 1 = every one). */
  probeRate: number;
};

type Env = Record<string, string | undefined>;

/**
 * Parse the env. `FEED_GO_SHADOW_URL` is the BASE of feed-go's internal listener (scheme + host +
 * port); the compare path is appended. A value that is not an http(s) URL disables the sampler.
 */
export function readFeedGoShadowConfig(env: Env = process.env): FeedGoShadowConfig {
  let url: string | undefined;
  let v1ImagesUrl: string | undefined;
  let v1ModelsUrl: string | undefined;
  let v1ModelsIdUrl: string | undefined;
  let infiniteUrl: string | undefined;
  let modelGetAllUrl: string | undefined;
  let modelAssociatedUrl: string | undefined;
  let imagePublishedAppUrl: string | undefined;
  let probeUrl: string | undefined;
  let probeInfiniteUrl: string | undefined;
  let probeModelGetAllUrl: string | undefined;
  const base = env.FEED_GO_SHADOW_URL?.trim();
  if (base) {
    try {
      const parsed = new URL(base);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        url = new URL(FEED_GO_SHADOW_PATH, parsed).toString();
        v1ImagesUrl = new URL(FEED_GO_SHADOW_V1_IMAGES_PATH, parsed).toString();
        v1ModelsUrl = new URL(FEED_GO_SHADOW_V1_MODELS_PATH, parsed).toString();
        v1ModelsIdUrl = new URL(FEED_GO_SHADOW_V1_MODELS_ID_PATH, parsed).toString();
        infiniteUrl = new URL(FEED_GO_SHADOW_INFINITE_PATH, parsed).toString();
        modelGetAllUrl = new URL(FEED_GO_SHADOW_MODEL_GET_ALL_PATH, parsed).toString();
        modelAssociatedUrl = new URL(FEED_GO_SHADOW_MODEL_ASSOCIATED_PATH, parsed).toString();
        imagePublishedAppUrl = new URL(FEED_GO_SHADOW_IMAGE_PUBLISHED_APP_PATH, parsed).toString();
        probeUrl = new URL(FEED_GO_PROBE_PATH, parsed).toString();
        probeInfiniteUrl = new URL(FEED_GO_PROBE_INFINITE_PATH, parsed).toString();
        probeModelGetAllUrl = new URL(FEED_GO_PROBE_MODEL_GET_ALL_PATH, parsed).toString();
      }
    } catch {
      url = undefined;
      v1ImagesUrl = undefined;
      v1ModelsUrl = undefined;
      v1ModelsIdUrl = undefined;
      infiniteUrl = undefined;
      modelGetAllUrl = undefined;
      modelAssociatedUrl = undefined;
      imagePublishedAppUrl = undefined;
      probeUrl = undefined;
      probeInfiniteUrl = undefined;
      probeModelGetAllUrl = undefined;
    }
  }
  return {
    url,
    v1ImagesUrl,
    v1ModelsUrl,
    v1ModelsIdUrl,
    infiniteUrl,
    modelGetAllUrl,
    modelAssociatedUrl,
    imagePublishedAppUrl,
    probeUrl,
    probeInfiniteUrl,
    probeModelGetAllUrl,
    probeRate: envNumber(env.FEED_GO_GOFIRST_PROBE_SAMPLE_RATE, 0, 0, 1),
    rate: envNumber(env.FEED_GO_SHADOW_SAMPLE_RATE, 0, 0, 1),
    timeoutMs: Math.round(
      envNumber(env.FEED_GO_SHADOW_TIMEOUT_MS, SHADOW_DEFAULT_TIMEOUT_MS, 1, SHADOW_MAX_TIMEOUT_MS)
    ),
    maxInFlight: Math.floor(
      envNumber(env.FEED_GO_SHADOW_MAX_IN_FLIGHT, SHADOW_DEFAULT_MAX_IN_FLIGHT, 1, 256)
    ),
    maxPerSecond: envNumber(
      env.FEED_GO_SHADOW_MAX_PER_SECOND,
      SHADOW_DEFAULT_MAX_PER_SECOND,
      0.1,
      1000
    ),
  };
}

type ShadowRequestLike = {
  method?: string;
  /** The request target as Node received it (`req.url`); read by the REST route only. */
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Partial<Record<string, string | string[]>>;
};

function headerValue(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return undefined;
}

/** Whether the request carries an API credential (a bearer header or `?token=`). */
function hasApiCredential(req: ShadowRequestLike) {
  return !!headerValue(req.headers.authorization) || req.query.token !== undefined;
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
  if (hasApiCredential(req)) out.authorization = 'present';
  return out;
}

type Captured = { envelope: unknown } | { data: unknown };

/** The REST routes: their samples carry a path and capture their own JSON body. */
type RestEndpoint = Extract<FeedGoShadowEndpoint, 'v1-images' | 'v1-models' | 'v1-models-id'>;
const REST_ENDPOINTS: ReadonlySet<FeedGoShadowEndpoint> = new Set<FeedGoShadowEndpoint>([
  'v1-images',
  'v1-models',
  'v1-models-id',
]);
function isRestEndpoint(endpoint: FeedGoShadowEndpoint): endpoint is RestEndpoint {
  return REST_ENDPOINTS.has(endpoint);
}

export type FeedGoShadowSample = {
  endpoint: FeedGoShadowEndpoint;
  /** Whether this sample holds an in-flight slot (a REST sample takes it in `finish`). */
  holdsSlot: boolean;
  /** The tRPC `input`, or the REST query string (without `?`). */
  input: string;
  /** The REST request's path (feed-go builds `metadata.nextPage` from it). */
  path?: string;
  headers: Record<string, string>;
  /** When the route began the request, epoch milliseconds (fractional); the probe sends it. */
  startedAt?: number;
  /** Whether the Go-first probe was already started for this sample (at most once). */
  probed?: boolean;
  captured?: Captured;
  /** Node's compared response headers, set in `finish`. */
  responseHeaders?: Record<string, string>;
  done: boolean;
};

export type FeedGoShadowDeps = {
  config: FeedGoShadowConfig;
  /** The `feed-go-shadow` flag. */
  enabled: () => boolean;
  /** The `feed-go-shadow-v1-images` flag (absent: the REST route is never sampled). */
  enabledV1Images?: () => boolean;
  /** The `feed-go-shadow-v1-models` flag (absent: neither model route is sampled). */
  enabledV1Models?: () => boolean;
  /** The `feed-go-shadow-infinite` flag (absent: `image.getInfinite` is never sampled). */
  enabledInfinite?: () => boolean;
  /** The `feed-go-shadow-model-getall` flag (absent: `model.getAll` is never sampled). */
  enabledModelGetAll?: () => boolean;
  /**
   * The `feed-go-shadow-model-associated` flag (absent: `model.getAssociatedResourcesCardData` is
   * never sampled).
   */
  enabledModelAssociated?: () => boolean;
  /**
   * The `feed-go-shadow-image-published-app` flag (absent: `image.getPublishedWithApp` is never
   * sampled).
   */
  enabledImagePublishedApp?: () => boolean;
  random?: () => number;
  fetch?: typeof fetch;
  record?: (outcome: FeedGoShadowOutcome, endpoint: FeedGoShadowEndpoint) => void;
  /** Counts the encode work one send paid (seconds of synchronous CPU, bytes of body). */
  recordEncode?: (seconds: number, bytes: number, endpoint: FeedGoShadowEndpoint) => void;
  /** Milliseconds clock for the per-second budget (production: `performance.now`). */
  now?: () => number;
  /** Runs the send after the request (production: `setImmediate`). */
  schedule?: (fn: () => void) => void;
  /** The `feed-go-gofirst-probe` flag (absent: never probed). */
  enabledProbe?: () => boolean;
  /** Counts a probe's outcome. */
  recordProbe?: (outcome: FeedGoProbeOutcome, endpoint: FeedGoShadowEndpoint) => void;
  /** Epoch milliseconds clock for the probe's start time (production: timeOrigin + now). */
  epochNow?: () => number;
};

/** A sampler instance. The module exports one wired to the env, the flag and the counter. */
export function createFeedGoShadow(deps: FeedGoShadowDeps) {
  const { config, enabled } = deps;
  const enabledV1Images = deps.enabledV1Images ?? (() => false);
  const enabledV1Models = deps.enabledV1Models ?? (() => false);
  const enabledInfinite = deps.enabledInfinite ?? (() => false);
  const enabledModelGetAll = deps.enabledModelGetAll ?? (() => false);
  const enabledModelAssociated = deps.enabledModelAssociated ?? (() => false);
  const enabledImagePublishedApp = deps.enabledImagePublishedApp ?? (() => false);
  const random = deps.random ?? Math.random;
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const record = deps.record ?? recordFeedGoShadowOutcome;
  const recordEncode = deps.recordEncode ?? recordFeedGoShadowEncode;
  const now = deps.now ?? (() => performance.now());
  const schedule = deps.schedule ?? ((fn: () => void) => void setImmediate(fn));
  const enabledProbe = deps.enabledProbe ?? (() => false);
  const recordProbe = deps.recordProbe ?? recordFeedGoProbeOutcome;
  const epochNow = deps.epochNow ?? (() => performance.timeOrigin + performance.now());
  const storage = new AsyncLocalStorage<FeedGoShadowSample>();
  let inFlight = 0;
  // A local bucket rather than `createBlockEventRateLimiter`: that one is a keyed, LRU-bounded
  // limiter for App Blocks events defaulting to Date.now; this needs one bucket on a monotonic clock.
  // One bucket per endpoint, each `maxPerSecond`, so a busy route cannot starve another.
  const buckets = createPerSecondBuckets(FEED_GO_SHADOW_ENDPOINTS, config.maxPerSecond, now);

  /** The mirrored REST routes: each one's compare URL and flag. */
  const restRoutes: Record<RestEndpoint, { url: string | undefined; enabled: () => boolean }> = {
    'v1-images': { url: config.v1ImagesUrl, enabled: enabledV1Images },
    'v1-models': { url: config.v1ModelsUrl, enabled: enabledV1Models },
    'v1-models-id': { url: config.v1ModelsIdUrl, enabled: enabledV1Models },
  };

  function release(sample: FeedGoShadowSample) {
    if (sample.done) return;
    sample.done = true;
    if (sample.holdsSlot) {
      sample.holdsSlot = false;
      inFlight--;
    }
  }

  /** The mirrored tRPC procedures: each one's endpoint label, compare URL and flag. */
  const trpcRoutes: Record<
    string,
    { endpoint: FeedGoShadowEndpoint; url: string | undefined; enabled: () => boolean }
  > = {
    [FEED_GO_SHADOW_PROCEDURE]: { endpoint: 'as-posts', url: config.url, enabled },
    [FEED_GO_SHADOW_INFINITE_PROCEDURE]: {
      endpoint: 'infinite',
      url: config.infiniteUrl,
      enabled: enabledInfinite,
    },
    [FEED_GO_SHADOW_MODEL_GET_ALL_PROCEDURE]: {
      endpoint: 'model-getall',
      url: config.modelGetAllUrl,
      enabled: enabledModelGetAll,
    },
    [FEED_GO_SHADOW_MODEL_ASSOCIATED_PROCEDURE]: {
      endpoint: 'model-associated',
      url: config.modelAssociatedUrl,
      enabled: enabledModelAssociated,
    },
  };

  /** The compare URL a sample of this endpoint is posted to. */
  function urlOf(endpoint: FeedGoShadowEndpoint) {
    if (isRestEndpoint(endpoint)) return restRoutes[endpoint].url;
    if (endpoint === 'infinite') return config.infiniteUrl;
    if (endpoint === 'model-getall') return config.modelGetAllUrl;
    if (endpoint === 'model-associated') return config.modelAssociatedUrl;
    if (endpoint === 'image-published-app') return config.imagePublishedAppUrl;
    return config.url;
  }

  /**
   * Decide whether this request is sampled. Returns the sample (holding one in-flight slot until
   * `finish` / the POST settles) or undefined. Never throws.
   */
  function begin(req: ShadowRequestLike): FeedGoShadowSample | undefined {
    try {
      if (config.rate <= 0) return undefined;
      if ((req.method ?? '').toUpperCase() !== 'GET') return undefined;
      // Exactly the mirrored procedures, unbatched (the web client never batches either:
      // NEVER_BATCH_PROCEDURES in src/utils/trpc.ts).
      const procedure = req.query.trpc;
      if (typeof procedure !== 'string' || req.query.batch !== undefined) return undefined;
      const route = Object.prototype.hasOwnProperty.call(trpcRoutes, procedure)
        ? trpcRoutes[procedure]
        : undefined;
      if (!route?.url) return undefined;
      const input = req.query.input;
      if (input !== undefined && typeof input !== 'string') return undefined;
      if (!route.enabled()) return undefined;
      if (random() >= config.rate) return undefined;
      const startedAt = epochNow();
      if (!admit(route.endpoint)) return undefined;
      const headers = pickShadowHeaders(req);
      inFlight++;
      return {
        endpoint: route.endpoint,
        holdsSlot: true,
        input: input ?? '',
        headers,
        startedAt,
        done: false,
      };
    } catch {
      return undefined;
    }
  }

  /** The bounds: the shared in-flight cap, then the endpoint's per-second bucket. Counts a drop. */
  function admit(endpoint: FeedGoShadowEndpoint): boolean {
    if (inFlight >= config.maxInFlight) {
      record('dropped_overload', endpoint);
      return false;
    }
    if (!buckets.take(endpoint)) {
      record('dropped_rate_limit', endpoint);
      return false;
    }
    return true;
  }

  /**
   * `begin` for a REST route: whether this request is sampled. The handler calls it after its cheap
   * rejects (and its bulkhead slot, where it has one), captures its own JSON body (`captureRest`)
   * and calls `finish`, which is where the in-flight slot and the token are taken. Never throws.
   */
  function beginRest(
    endpoint: RestEndpoint,
    req: ShadowRequestLike
  ): FeedGoShadowSample | undefined {
    try {
      const route = restRoutes[endpoint];
      if (!route.url || config.rate <= 0) return undefined;
      if ((req.method ?? '').toUpperCase() !== 'GET') return undefined;
      if (!route.enabled()) return undefined;
      if (random() >= config.rate) return undefined;
      // Node's body can echo the credential (`metadata.nextPage` keeps `?token=`), and feed-go
      // falls back on any credential: never mirrored, only counted.
      if (hasApiCredential(req)) {
        record('skipped_credential', endpoint);
        return undefined;
      }
      const target = req.url ?? '';
      const q = target.indexOf('?');
      const path = q < 0 ? target : target.slice(0, q);
      const input = q < 0 ? '' : target.slice(q + 1);
      const headers = pickShadowHeaders(req);
      return {
        endpoint,
        holdsSlot: false,
        input,
        path: path || undefined,
        headers,
        done: false,
      };
    } catch {
      return undefined;
    }
  }

  /** `beginRest` for `GET /api/v1/images`. */
  function beginV1Images(req: ShadowRequestLike): FeedGoShadowSample | undefined {
    return beginRest('v1-images', req);
  }

  /**
   * The REST handler's capture: keeps a REFERENCE to the body it is about to `res.json`, encoded
   * later, off the request path. First call wins. Never throws.
   */
  function captureRest(sample: FeedGoShadowSample, body: unknown): void {
    try {
      if (!isRestEndpoint(sample.endpoint) || sample.captured || sample.done) return;
      sample.captured = { envelope: body };
    } catch {
      /* never throw from the handler */
    }
  }

  /**
   * The Go-first probe for a sampled `as-posts` request: call it at the start of the request, before
   * the handler runs. Starts the POST synchronously (its bytes leave on a later turn of the event
   * loop) and never awaits it; the probe holds its own in-flight slot until the POST settles. At most
   * once per sample. Never throws.
   */
  function probe(sample: FeedGoShadowSample | undefined): void {
    try {
      if (!sample || sample.probed) return;
      // The tRPC procedures feed-go has a probe for; a REST sample is never probed.
      const url =
        sample.endpoint === 'as-posts'
          ? config.probeUrl
          : sample.endpoint === 'infinite'
          ? config.probeInfiniteUrl
          : sample.endpoint === 'model-getall'
          ? config.probeModelGetAllUrl
          : undefined;
      if (!url || config.probeRate <= 0) return;
      if (!enabledProbe()) return;
      if (random() >= config.probeRate) return;
      sample.probed = true;
      if (inFlight >= config.maxInFlight) {
        recordProbe('dropped_overload', sample.endpoint);
        return;
      }
      const body = JSON.stringify({
        input: sample.input,
        headers: sample.headers,
        startedAt: sample.startedAt,
      });
      inFlight++;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        inFlight--;
      };
      let pending: Promise<Response>;
      try {
        pending = doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch {
        recordProbe('error', sample.endpoint);
        done();
        return;
      }
      pending
        .then(
          (res) => {
            recordProbe(res.ok ? 'sent' : 'rejected', sample.endpoint);
            res.body?.cancel().catch(() => undefined);
          },
          (err: unknown) => {
            const name = (err as { name?: string } | undefined)?.name;
            recordProbe(
              name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error',
              sample.endpoint
            );
          }
        )
        .catch(() => undefined)
        .finally(done);
    } catch {
      /* never throw from the route */
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
      // The tRPC samples (as-posts, infinite, model-getall, model-associated,
      // image-published-app); a REST sample captures its own body.
      if (!sample || isRestEndpoint(sample.endpoint) || sample.captured || sample.done) return;
      sample.captured = wroteDevalue ? { data } : { envelope: written };
    } catch {
      /* never throw from the serializer */
    }
  }

  function send(sample: FeedGoShadowSample): void {
    const { endpoint } = sample;
    let body: string;
    try {
      const started = now();
      const captured = sample.captured!;
      const node = 'envelope' in captured ? captured.envelope : superjson.serialize(captured.data);
      // No status: only 200s are posted, and feed-go does not compare it.
      const response = sample.responseHeaders ? { responseHeaders: sample.responseHeaders } : {};
      body = JSON.stringify(
        isRestEndpoint(endpoint)
          ? { input: sample.input, path: sample.path, headers: sample.headers, node, ...response }
          : { input: sample.input, headers: sample.headers, node, ...response }
      );
      // Drop the reference to the captured page now that it is encoded: only `body` is needed
      // while the POST is in flight.
      sample.captured = undefined;
      recordEncode((now() - started) / 1000, Buffer.byteLength(body), endpoint);
    } catch {
      record('skipped_encode', endpoint);
      release(sample);
      return;
    }
    let pending: Promise<Response>;
    try {
      pending = doFetch(urlOf(endpoint)!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      record('error', endpoint);
      release(sample);
      return;
    }
    pending
      .then(
        (res) => {
          record(res.ok ? 'sent' : 'rejected', endpoint);
          // Free the connection; feed-go's 202 has no body worth reading.
          res.body?.cancel().catch(() => undefined);
        },
        (err: unknown) => {
          const name = (err as { name?: string } | undefined)?.name;
          record(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error', endpoint);
        }
      )
      .catch(() => undefined)
      .finally(() => release(sample));
  }

  /**
   * After the handler: queue the POST if Node answered 200 and a body was captured, with the compared
   * response headers (when the route passes them). A response whose headers cannot be read is not
   * sent (`skipped_headers`), so its comparison is not silently lost. Synchronous, returns nothing to
   * await, never throws.
   */
  function finish(
    sample: FeedGoShadowSample,
    statusCode: number,
    response?: ShadowResponseLike
  ): void {
    try {
      if (sample.done) return;
      if (statusCode !== 200) {
        record('skipped_status', sample.endpoint);
        release(sample);
        return;
      }
      if (!sample.captured) {
        record('skipped_no_capture', sample.endpoint);
        release(sample);
        return;
      }
      if (typeof response?.getHeaders === 'function') {
        let headers: ShadowResponseHeaders;
        try {
          headers = response.getHeaders();
        } catch {
          record('skipped_headers', sample.endpoint);
          sample.captured = undefined;
          release(sample);
          return;
        }
        sample.responseHeaders = pickShadowResponseHeaders(headers);
      }
      if (!sample.holdsSlot) {
        // A REST sample is bounded here, after the handler: it held nothing while it ran.
        if (!admit(sample.endpoint)) {
          sample.captured = undefined;
          release(sample);
          return;
        }
        inFlight++;
        sample.holdsSlot = true;
      }
      schedule(() => send(sample));
    } catch {
      release(sample);
    }
  }

  return {
    begin,
    beginRest,
    beginV1Images,
    probe,
    run,
    capture,
    captureRest,
    captureV1Images: captureRest,
    finish,
    inFlight: () => inFlight,
  };
}

export type FeedGoShadow = ReturnType<typeof createFeedGoShadow>;

let instance: FeedGoShadow | undefined;

function getInstance(): FeedGoShadow {
  instance ??= createFeedGoShadow({
    config: readFeedGoShadowConfig(),
    enabled: createCachedFlagGate(readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW)),
    enabledV1Images: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW_V1_IMAGES)
    ),
    enabledV1Models: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW_V1_MODELS)
    ),
    enabledInfinite: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW_INFINITE)
    ),
    enabledModelGetAll: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW_MODEL_GET_ALL)
    ),
    enabledModelAssociated: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW_MODEL_ASSOCIATED)
    ),
    enabledImagePublishedApp: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_SHADOW_IMAGE_PUBLISHED_APP)
    ),
    enabledProbe: createCachedFlagGate(
      readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_GO_GOFIRST_PROBE)
    ),
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

/** `GET /api/v1/images`: whether this request is sampled (see `beginV1Images`). Never throws. */
export function beginFeedGoShadowV1Images(req: ShadowRequestLike): FeedGoShadowSample | undefined {
  try {
    const owner = getInstance();
    const sample = owner.beginV1Images(req);
    if (sample) owners.set(sample, owner);
    return sample;
  } catch {
    return undefined;
  }
}

/**
 * `GET /api/v1/models` (`kind: 'list'`) or `GET /api/v1/models/[id]` (`kind: 'id'`): whether this
 * request is sampled (see `beginRest`). Never throws.
 */
export function beginFeedGoShadowV1Models(
  req: ShadowRequestLike,
  kind: 'list' | 'id'
): FeedGoShadowSample | undefined {
  try {
    const owner = getInstance();
    const sample = owner.beginRest(kind === 'list' ? 'v1-models' : 'v1-models-id', req);
    if (sample) owners.set(sample, owner);
    return sample;
  } catch {
    return undefined;
  }
}

/** A REST route: keep a reference to the 200 body the handler is about to write. */
export function captureFeedGoShadowRest(sample: FeedGoShadowSample, body: unknown): void {
  try {
    (owners.get(sample) ?? getInstance()).captureRest(sample, body);
  } catch {
    /* never throw from the handler */
  }
}

/** `GET /api/v1/images`: `captureFeedGoShadowRest` under its original name. */
export const captureFeedGoShadowV1Images = captureFeedGoShadowRest;

/** The `/api/v1/images` request shapes, by what feed-go can port (see FEED_GO_V1_SHAPE_CLASSES). */
export type FeedGoV1ShapeInput = {
  ids?: readonly unknown[];
  imageId?: unknown;
  modelId?: unknown;
  modelVersionId?: unknown;
  tags?: readonly unknown[];
  baseModels?: readonly unknown[];
  withMeta?: boolean;
  withTags?: boolean;
};

/**
 * The query keys feed-go's ParseV1 accepts: imagesEndpointSchema's (the keys its generated
 * allow-list, apps/feed-go/internal/inputschema/schemas.json, is projected from and held to by the
 * schema-drift test) plus `token`, the API key. Any other key is `input-unknown-key` there.
 */
const V1_ACCEPTED_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(imagesEndpointSchema.shape),
  'token',
]);

/**
 * The shape class of one `/api/v1/images` request, from its parsed query (null when it did not
 * parse), its raw query (zod strips an unknown key, so only `req.query` shows one) and its final
 * status, in feed-go's own fallback order (ParseV1). Pure and cheap.
 */
export function feedGoV1ShapeClass(
  req: ShadowRequestLike,
  data: FeedGoV1ShapeInput | null,
  statusCode: number
): FeedGoV1ShapeClass {
  try {
    if (statusCode !== 200 || !data) return 'non200';
    if (hasApiCredential(req)) return 'api_key';
    if (data.imageId !== undefined) return 'unported_imageId';
    if (data.tags !== undefined) return 'unported_tags';
    if (data.baseModels !== undefined) return 'unported_baseModels';
    if (Object.keys(req.query).some((k) => !V1_ACCEPTED_KEYS.has(k))) return 'unported_unknownKey';
    if (data.modelId && !data.modelVersionId) return 'unported_modelId_only';
    if (data.withTags) return 'unported_withTags';
    return 'ported';
  } catch {
    return 'non200';
  }
}

/**
 * The Go-first probe for a sampled request (see `probe`): call at the start of the request, before
 * the handler. Never throws, never awaits.
 */
export function probeFeedGoShadow(sample: FeedGoShadowSample | undefined): void {
  if (!sample) return;
  try {
    (owners.get(sample) ?? getInstance()).probe(sample);
  } catch {
    /* never throw from the route */
  }
}

export function runWithFeedGoShadow<T>(sample: FeedGoShadowSample | undefined, fn: () => T): T {
  if (!sample) return fn();
  return (owners.get(sample) ?? getInstance()).run(sample, fn);
}

export function captureFeedGoShadowResponse(data: unknown, written: unknown, devalue: boolean) {
  getInstance().capture(data, written, devalue);
}

export function finishFeedGoShadow(
  sample: FeedGoShadowSample,
  statusCode: number,
  response?: ShadowResponseLike
): void {
  (owners.get(sample) ?? getInstance()).finish(sample, statusCode, response);
}
