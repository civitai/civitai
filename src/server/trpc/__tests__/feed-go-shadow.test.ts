/**
 * The feed-go shadow sampler (`~/server/trpc/feed-go-shadow`): which requests are sampled, what
 * is forwarded (and what is not), the in-flight bound, and that every failure is swallowed into
 * an outcome instead of reaching the request.
 *
 * Driven through `createFeedGoShadow` with injected flag / random / fetch / schedule, so each case
 * pins one decision. The end-to-end path through the real route and transformer is
 * `src/server/__tests__/trpc-feed-go-shadow.test.ts`.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeedGoShadow,
  feedGoV1ShapeClass,
  FEED_GO_TRAINING_DATA_SQL_HEADER,
  FEED_GO_SHADOW_MODEL_ASSOCIATED_PATH,
  FEED_GO_SHADOW_MODEL_GET_ALL_PATH,
  FEED_GO_SHADOW_PATH,
  FEED_GO_COMPARED_RESPONSE_HEADERS,
  FEED_GO_COMPARED_REST_RESPONSE_HEADERS,
  pickShadowHeaders,
  pickShadowResponseHeaders,
  readFeedGoShadowConfig,
  type RestSampleOptions,
  SHADOW_DEFAULT_MAX_IN_FLIGHT,
  SHADOW_DEFAULT_MAX_PER_SECOND,
  SHADOW_DEFAULT_TIMEOUT_MS,
  type FeedGoShadowConfig,
} from '~/server/trpc/feed-go-shadow';
import { pickSessionCookies } from '~/server/utils/session-cookies';

const URL_ = 'http://feed-go.test:9090/internal/shadow/image.getImagesAsPostsInfinite';
const V1_URL = 'http://feed-go.test:9090/internal/shadow/api/v1/images';
const PROBE_URL = 'http://feed-go.test:9090/internal/probe/image.getImagesAsPostsInfinite';
const INF_URL = 'http://feed-go.test:9090/internal/shadow/image.getInfinite';
const MODELS_URL = 'http://feed-go.test:9090/internal/shadow/model.getAll';
const ASSOC_URL = 'http://feed-go.test:9090/internal/shadow/model.getAssociatedResourcesCardData';
const V1_MODELS_URL = 'http://feed-go.test:9090/internal/shadow/api/v1/models';
const V1_MODEL_ID_URL = 'http://feed-go.test:9090/internal/shadow/api/v1/models/id';
const INPUT = '{"json":{"modelId":7,"limit":50},"meta":{"values":{"cursor":["undefined"]}}}';

function config(overrides: Partial<FeedGoShadowConfig> = {}): FeedGoShadowConfig {
  return {
    url: URL_,
    v1ImagesUrl: V1_URL,
    infiniteUrl: INF_URL,
    modelGetAllUrl: MODELS_URL,
    modelAssociatedUrl: ASSOC_URL,
    v1ModelsUrl: V1_MODELS_URL,
    v1ModelsIdUrl: V1_MODEL_ID_URL,
    rate: 1,
    timeoutMs: 500,
    maxInFlight: 4,
    maxPerSecond: 1000,
    probeUrl: PROBE_URL,
    probeInfiniteUrl: undefined,
    probeModelGetAllUrl: undefined,
    probeRate: 0,
    v1ModelsCredentials: false,
    v1ModelsQuery: false,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    headers: { host: 'civitai.com' },
    query: { trpc: 'image.getImagesAsPostsInfinite', input: INPUT },
    ...overrides,
  } as {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    query: Partial<Record<string, string | string[]>>;
  };
}

/** A sampler whose scheduled sends run only when `flush()` is called. */
function harness(
  opts: {
    config?: Partial<FeedGoShadowConfig>;
    enabled?: boolean;
    /** The `feed-go-shadow-v1-images` flag (default on here, as `enabled` is). */
    v1?: boolean;
    /** The `feed-go-shadow-infinite` flag (default OFF here, as in production). */
    infinite?: boolean;
    /** The `feed-go-shadow-model-getall` flag (default OFF here, as in production). */
    models?: boolean;
    /** The `feed-go-shadow-model-associated` flag (default OFF here, as in production). */
    associated?: boolean;
    /** The `feed-go-shadow-v1-models` flag (default on here, as `v1` is). */
    v1Models?: boolean;
    random?: number;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => number;
    modelSampleHeaders?: () => Record<string, string>;
  } = {}
) {
  const outcomes: string[] = [];
  const endpoints: string[] = [];
  const encodes: Array<{ seconds: number; bytes: number }> = [];
  const queued: Array<() => void> = [];
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    opts.fetchImpl ?? (async () => new Response(null, { status: 202 }))
  );
  const shadow = createFeedGoShadow({
    config: config(opts.config),
    enabled: () => opts.enabled ?? true,
    enabledV1Images: () => opts.v1 ?? true,
    enabledInfinite: () => opts.infinite ?? false,
    enabledModelGetAll: () => opts.models ?? false,
    enabledModelAssociated: () => opts.associated ?? false,
    enabledV1Models: () => opts.v1Models ?? true,
    random: () => opts.random ?? 0,
    fetch: fetchMock as unknown as typeof fetch,
    record: (o, endpoint) => {
      outcomes.push(o);
      endpoints.push(endpoint);
    },
    recordEncode: (seconds, bytes) => void encodes.push({ seconds, bytes }),
    now: opts.now ?? (() => 0),
    schedule: (fn) => void queued.push(fn),
    modelSampleHeaders: opts.modelSampleHeaders,
  });
  const flush = async () => {
    while (queued.length) queued.shift()!();
    // Let the fetch promise chain settle.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { shadow, outcomes, endpoints, encodes, fetchMock, flush, queued };
}

/** Run one request through begin → handler (serializing `written`) → finish. */
function serve(
  h: ReturnType<typeof harness>,
  req = request(),
  {
    status = 200,
    data = { items: [] },
    written = superjson.serialize(data),
    devalue = false,
  }: {
    status?: number;
    data?: Parameters<typeof superjson.serialize>[0];
    // What the transformer wrote: a superjson envelope, or a devalue string.
    written?: unknown;
    devalue?: boolean;
  } = {}
) {
  const sample = h.shadow.begin(req);
  h.shadow.run(sample, () => h.shadow.capture(data, written, devalue));
  if (sample) h.shadow.finish(sample, status);
  return sample;
}

describe('readFeedGoShadowConfig', () => {
  it('is disabled with no URL, and defaults to rate 0', () => {
    expect(readFeedGoShadowConfig({})).toEqual({
      url: undefined,
      v1ImagesUrl: undefined,
      infiniteUrl: undefined,
      modelGetAllUrl: undefined,
      modelAssociatedUrl: undefined,
      v1ModelsUrl: undefined,
      v1ModelsIdUrl: undefined,
      rate: 0,
      timeoutMs: SHADOW_DEFAULT_TIMEOUT_MS,
      maxInFlight: SHADOW_DEFAULT_MAX_IN_FLIGHT,
      maxPerSecond: SHADOW_DEFAULT_MAX_PER_SECOND,
      probeUrl: undefined,
      probeInfiniteUrl: undefined,
      probeModelGetAllUrl: undefined,
      probeRate: 0,
      probeV1ImagesUrl: undefined,
      probeV1ImagesRate: 0,
      v1ModelsCredentials: false,
      v1ModelsQuery: false,
      corpusOnlyRate: 0,
    });
  });

  it('appends the compare path to the base URL', () => {
    const c = readFeedGoShadowConfig({
      FEED_GO_SHADOW_URL: 'http://feed-go.internal.test:9090',
      FEED_GO_SHADOW_SAMPLE_RATE: '0.25',
      FEED_GO_SHADOW_TIMEOUT_MS: '750',
      FEED_GO_SHADOW_MAX_IN_FLIGHT: '3',
      FEED_GO_SHADOW_MAX_PER_SECOND: '2.5',
      FEED_GO_GOFIRST_PROBE_SAMPLE_RATE: '0.5',
    });
    expect(c).toEqual({
      url: `http://feed-go.internal.test:9090${FEED_GO_SHADOW_PATH}`,
      v1ImagesUrl: 'http://feed-go.internal.test:9090/internal/shadow/api/v1/images',
      infiniteUrl: 'http://feed-go.internal.test:9090/internal/shadow/image.getInfinite',
      modelGetAllUrl: 'http://feed-go.internal.test:9090/internal/shadow/model.getAll',
      modelAssociatedUrl:
        'http://feed-go.internal.test:9090/internal/shadow/model.getAssociatedResourcesCardData',
      v1ModelsUrl: 'http://feed-go.internal.test:9090/internal/shadow/api/v1/models',
      v1ModelsIdUrl: 'http://feed-go.internal.test:9090/internal/shadow/api/v1/models/id',
      siteSearchUrl: 'http://feed-go.internal.test:9090/internal/shadow/api/search',
      rate: 0.25,
      timeoutMs: 750,
      maxInFlight: 3,
      maxPerSecond: 2.5,
      probeUrl: 'http://feed-go.internal.test:9090/internal/probe/image.getImagesAsPostsInfinite',
      probeInfiniteUrl: 'http://feed-go.internal.test:9090/internal/probe/image.getInfinite',
      probeModelGetAllUrl: 'http://feed-go.internal.test:9090/internal/probe/model.getAll',
      probeRate: 0.5,
      probeV1ImagesUrl: 'http://feed-go.internal.test:9090/internal/probe/api/v1/images',
      probeV1ImagesRate: 0,
      v1ModelsCredentials: false,
      v1ModelsQuery: false,
      corpusOnlyRate: 0,
    });
  });

  it('reads FEED_GO_SHADOW_V1_MODELS_CREDENTIALS as on only for true or 1', () => {
    for (const [value, want] of [
      [undefined, false],
      ['', false],
      ['false', false],
      ['yes', false],
      ['true', true],
      [' TRUE ', true],
      ['1', true],
    ] as const) {
      expect(
        readFeedGoShadowConfig({ FEED_GO_SHADOW_V1_MODELS_CREDENTIALS: value }).v1ModelsCredentials
      ).toBe(want);
    }
  });

  it('reads FEED_GO_SHADOW_V1_MODELS_QUERY as on only for true or 1', () => {
    for (const [value, want] of [
      [undefined, false],
      ['', false],
      ['false', false],
      ['on', false],
      ['true', true],
      [' True ', true],
      ['1', true],
    ] as const) {
      expect(readFeedGoShadowConfig({ FEED_GO_SHADOW_V1_MODELS_QUERY: value }).v1ModelsQuery).toBe(
        want
      );
    }
  });

  it('reads FEED_GO_SHADOW_CORPUS_ONLY_RATE: unset and junk are 0 (off), a number is clamped to [0, 1]', () => {
    for (const [value, want] of [
      [undefined, 0],
      ['', 0],
      ['on', 0],
      ['-0.5', 0],
      ['0.125', 0.125],
      ['3', 1],
    ] as const) {
      expect(
        readFeedGoShadowConfig({ FEED_GO_SHADOW_CORPUS_ONLY_RATE: value }).corpusOnlyRate
      ).toBe(want);
    }
  });

  it('rejects a non-http URL and clamps out-of-range numbers', () => {
    const c = readFeedGoShadowConfig({
      FEED_GO_SHADOW_URL: 'redis://x:1',
      FEED_GO_SHADOW_SAMPLE_RATE: '7',
      FEED_GO_SHADOW_TIMEOUT_MS: '999999',
      FEED_GO_SHADOW_MAX_IN_FLIGHT: '-2',
      FEED_GO_SHADOW_MAX_PER_SECOND: '0',
    });
    expect(c.url).toBeUndefined();
    expect(c.v1ImagesUrl).toBeUndefined();
    expect(c.probeUrl).toBeUndefined();
    expect(c.infiniteUrl).toBeUndefined();
    expect(c.modelGetAllUrl).toBeUndefined();
    expect(c.modelAssociatedUrl).toBeUndefined();
    expect(c.v1ModelsUrl).toBeUndefined();
    expect(c.v1ModelsIdUrl).toBeUndefined();
    expect(c.rate).toBe(1);
    expect(c.timeoutMs).toBe(10_000);
    expect(c.maxInFlight).toBe(1);
    expect(c.maxPerSecond).toBe(0.1);
    expect(readFeedGoShadowConfig({ FEED_GO_SHADOW_URL: 'not a url' }).url).toBeUndefined();
    expect(readFeedGoShadowConfig({ FEED_GO_SHADOW_SAMPLE_RATE: 'abc' }).rate).toBe(0);
    expect(readFeedGoShadowConfig({ FEED_GO_GOFIRST_PROBE_SAMPLE_RATE: '3' }).probeRate).toBe(1);
  });
});

describe('pickSessionCookies / pickShadowHeaders', () => {
  it('keeps only the session cookies, in order, with their exact values', () => {
    expect(
      pickSessionCookies(
        '_ga=GA1.2.3; __Secure-civ-token=a.b.c; theme=dark; __Host-civ-token=d.e.f; civ-device=x'
      )
    ).toBe('__Secure-civ-token=a.b.c; __Host-civ-token=d.e.f');
    expect(pickSessionCookies('civ-token=plain')).toBe('civ-token=plain');
    // A name that merely contains the session name is not a session cookie.
    expect(pickSessionCookies('xciv-token=1; civ-token-old=2; __Secure-civitai-token=3')).toBe(
      undefined
    );
    expect(pickSessionCookies(undefined)).toBeUndefined();
  });

  it('forwards exactly the headers the answer depends on', () => {
    const headers = pickShadowHeaders(
      request({
        headers: {
          host: 'civitai.green',
          cookie: 'a=1; __Secure-civ-token=tok',
          'cf-ipcountry': 'GB',
          'cf-region-code': 'ENG',
          'x-isuk': 'true',
          'x-civitai-verified-bot': 'googlebot',
          authorization: 'Bearer SECRET-KEY',
          'user-agent': 'Mozilla',
          'x-forwarded-for': '203.0.113.9',
          'x-client-version': '5.0.1',
        },
      })
    );
    expect(headers).toEqual({
      host: 'civitai.green',
      cookie: '__Secure-civ-token=tok',
      'cf-ipcountry': 'GB',
      'cf-region-code': 'ENG',
      'x-isuk': 'true',
      'x-civitai-verified-bot': 'googlebot',
      // Presence only: the credential itself never leaves the pod.
      authorization: 'present',
    });
    expect(JSON.stringify(headers)).not.toContain('SECRET-KEY');
  });

  it('marks a ?token= credential as present too, and omits absent headers', () => {
    expect(pickShadowHeaders(request({ headers: {}, query: { token: 'abc' } }))).toEqual({
      authorization: 'present',
    });
    expect(pickShadowHeaders(request({ headers: { cookie: 'theme=dark' } }))).toEqual({});
  });
});

describe('pickShadowResponseHeaders', () => {
  it('keeps only the compared headers, lowercased, Set-Cookie as presence, each bounded', () => {
    expect(
      pickShadowResponseHeaders({
        'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30',
        vary: ['Accept-Encoding', 'Cookie'],
        'cache-tag': 'images, user-1',
        'set-cookie': ['session=secret-value; HttpOnly'],
        'x-update-required': 'true',
        'x-handled-by': 'pod-a',
        'content-length': 123,
        'x-ratelimit-remaining': '9',
      })
    ).toEqual({
      'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30',
      vary: 'Accept-Encoding, Cookie',
      'cache-tag': 'images, user-1',
      'set-cookie': 'present',
      'x-update-required': 'true',
    });
    expect(pickShadowResponseHeaders({ 'cache-tag': 'x'.repeat(5000) })['cache-tag']).toHaveLength(
      1024
    );
    expect(pickShadowResponseHeaders({})).toEqual({});
  });

  it('an empty Set-Cookie (no cookie) is absent, not present', () => {
    expect(pickShadowResponseHeaders({ 'set-cookie': [] })).toEqual({});
    expect(pickShadowResponseHeaders({ 'set-cookie': '' })).toEqual({});
    expect(pickShadowResponseHeaders({ 'set-cookie': ['a=1'], vary: [] })).toEqual({
      'set-cookie': 'present',
    });
  });
});

describe('createFeedGoShadow — response headers', () => {
  it('posts the compared response headers the route passes to finish, and no status', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    const data = { items: [] };
    h.shadow.run(sample, () => h.shadow.capture(data, superjson.serialize(data), false));
    h.shadow.finish(sample, 200, {
      getHeaders: () => ({
        'cache-control': 'max-age=0, private, no-cache',
        'set-cookie': 'a=secret',
        'x-handled-by': 'pod-a',
      }),
    });
    await h.flush();
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('status');
    expect(body.responseHeaders).toEqual({
      'cache-control': 'max-age=0, private, no-cache',
      'set-cookie': 'present',
    });
    // The cookie's value never leaves the process.
    expect(h.fetchMock.mock.calls[0][1].body as string).not.toContain('secret');
  });

  it('omits responseHeaders for a response without getHeaders (a test double), and still sends', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    const data = { items: [] };
    h.shadow.run(sample, () => h.shadow.capture(data, superjson.serialize(data), false));
    h.shadow.finish(sample, 200, {});
    await h.flush();
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('responseHeaders');
    expect(h.outcomes).toEqual(['sent']);
  });

  it('records skipped_headers, sends nothing and frees the slot when getHeaders throws', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    const data = { items: [] };
    h.shadow.run(sample, () => h.shadow.capture(data, superjson.serialize(data), false));
    expect(h.shadow.inFlight()).toBe(1);
    h.shadow.finish(sample, 200, {
      getHeaders: () => {
        throw new Error('headers gone');
      },
    });
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_headers']);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('omits responseHeaders when the route passes none', async () => {
    const h = harness();
    serve(h);
    await h.flush();
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('responseHeaders');
  });
});

describe('createFeedGoShadow — sampling decision', () => {
  it('samples a GET of the procedure and POSTs input, headers and the written envelope', async () => {
    const h = harness();
    const data = { items: [{ id: 1, createdAt: new Date('2026-01-02T00:00:00.000Z') }] };
    const written = superjson.serialize(data);
    serve(h, request({ headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t; x=y' } }), {
      data,
      written,
    });
    // Nothing is sent on the request path: only once the scheduled send runs.
    expect(h.fetchMock).not.toHaveBeenCalled();
    await h.flush();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      input: INPUT,
      headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t' },
      node: JSON.parse(JSON.stringify(written)),
      sampleRate: 1,
    });
    expect(h.outcomes).toEqual(['sent']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it.each([
    ['flag off', { enabled: false }, request()],
    ['no URL', { config: { url: undefined } }, request()],
    ['rate 0', { config: { rate: 0 } }, request()],
    ['not sampled (random >= rate)', { config: { rate: 0.3 }, random: 0.3 }, request()],
    ['POST (methodOverride)', {}, request({ method: 'POST' })],
    // image.getInfinite with its own flag off (the gallery flag does not sample it).
    ['another procedure', {}, request({ query: { trpc: 'image.getInfinite', input: INPUT } })],
    // model.getAll with its own flag off (the gallery flag does not sample it).
    ['model.getAll, its flag off', {}, request({ query: { trpc: 'model.getAll', input: INPUT } })],
    [
      'model.getAll with no URL',
      { models: true, config: { modelGetAllUrl: undefined } },
      request({ query: { trpc: 'model.getAll', input: INPUT } }),
    ],
    [
      'model.getAssociatedResourcesCardData, its flag off',
      { models: true },
      request({ query: { trpc: 'model.getAssociatedResourcesCardData', input: INPUT } }),
    ],
    [
      'model.getAssociatedResourcesCardData with no URL',
      { associated: true, config: { modelAssociatedUrl: undefined } },
      request({ query: { trpc: 'model.getAssociatedResourcesCardData', input: INPUT } }),
    ],
    [
      'model.getAssociatedResourcesCardData batched',
      { associated: true },
      request({
        query: { trpc: 'model.getAssociatedResourcesCardData', batch: '1', input: INPUT },
      }),
    ],
    [
      'an unmirrored procedure',
      { infinite: true },
      request({ query: { trpc: 'image.get', input: INPUT } }),
    ],
    [
      'image.getInfinite with no URL',
      { infinite: true, config: { infiniteUrl: undefined } },
      request({ query: { trpc: 'image.getInfinite', input: INPUT } }),
    ],
    [
      'a batch',
      {},
      request({ query: { trpc: 'image.getImagesAsPostsInfinite', batch: '1', input: INPUT } }),
    ],
    [
      'a multi-procedure path',
      {},
      request({ query: { trpc: 'image.getImagesAsPostsInfinite,user.getCreator', input: INPUT } }),
    ],
    // feed-go's serve-side parity replay of a request it served (feed-go-parity-replay.ts), on each
    // mirrored procedure with its flag on: feed-go compares it itself.
    [
      'a feed-go parity replay',
      {},
      request({ headers: { host: 'civitai.com', 'x-feed-go-parity-replay': '1' } }),
    ],
    [
      'a feed-go parity replay of image.getInfinite',
      { infinite: true },
      request({
        headers: { host: 'civitai.com', 'x-feed-go-parity-replay': '1' },
        query: { trpc: 'image.getInfinite', input: INPUT },
      }),
    ],
    [
      'a feed-go parity replay of model.getAll',
      { models: true },
      request({
        headers: { host: 'civitai.com', 'x-feed-go-parity-replay': '1' },
        query: { trpc: 'model.getAll', input: INPUT },
      }),
    ],
  ])('does not sample: %s', async (_name, opts, req) => {
    const h = harness(opts as Parameters<typeof harness>[0]);
    expect(serve(h, req)).toBeUndefined();
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([]);
  });

  // A procedure name is attacker-chosen: a route must be an own key of the route table, never one
  // inherited through a (polluted) prototype. The inherited route here is complete (URL, flag on),
  // so only the own-key check stands between it and a sample.
  it('does not sample a route inherited through the prototype', async () => {
    const key = 'polluted.procedure';
    Object.defineProperty(Object.prototype, key, {
      value: { endpoint: 'infinite', url: INF_URL, enabled: () => true },
      configurable: true,
    });
    try {
      const h = harness({ infinite: true, models: true });
      expect(serve(h, request({ query: { trpc: key, input: INPUT } }))).toBeUndefined();
      await h.flush();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual([]);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  it('samples model.getAssociatedResourcesCardData under its own flag and posts it to its own path', async () => {
    const h = harness({ associated: true, enabled: false });
    const input = '{"json":{"fromId":9001,"type":"Suggested","browsingLevel":1}}';
    const data = [{ resourceType: 'model', id: 5001, sponsored: false }];
    const written = superjson.serialize(data);
    const sample = serve(
      h,
      request({ query: { trpc: 'model.getAssociatedResourcesCardData', input } }),
      { data, written }
    );
    expect(sample?.endpoint).toBe('model-associated');
    await h.flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(ASSOC_URL);
    expect(url.endsWith(FEED_GO_SHADOW_MODEL_ASSOCIATED_PATH)).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      input,
      headers: { host: 'civitai.com' },
      node: JSON.parse(JSON.stringify(written)),
      sampleRate: 1,
    });
    expect(h.outcomes).toEqual(['sent']);
    expect(h.endpoints).toEqual(['model-associated']);
  });

  it('the model.getAll flag does not sample model.getAssociatedResourcesCardData, nor its flag model.getAll', () => {
    const assoc = request({
      query: { trpc: 'model.getAssociatedResourcesCardData', input: INPUT },
    });
    const getAll = request({ query: { trpc: 'model.getAll', input: INPUT } });
    expect(harness({ models: true }).shadow.begin(assoc)).toBeUndefined();
    expect(harness({ associated: true }).shadow.begin(getAll)).toBeUndefined();
    expect(harness({ associated: true }).shadow.begin(assoc)?.endpoint).toBe('model-associated');
  });

  it('samples a fraction: random below the rate is sampled, at the rate is not', () => {
    expect(harness({ config: { rate: 0.3 }, random: 0.29 }).shadow.begin(request())).toBeDefined();
    expect(harness({ config: { rate: 0.3 }, random: 0.3 }).shadow.begin(request())).toBeUndefined();
  });
});

describe('createFeedGoShadow — never on the user path', () => {
  it('drops a sample beyond maxInFlight, and frees the slot when the POST settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      config: { maxInFlight: 2 },
      fetchImpl: async () => {
        await gate;
        return new Response(null, { status: 202 });
      },
    });
    expect(serve(h)).toBeDefined();
    expect(serve(h)).toBeDefined();
    expect(h.shadow.inFlight()).toBe(2);
    expect(serve(h)).toBeUndefined();
    expect(h.outcomes).toEqual(['dropped_overload']);

    await h.flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.shadow.inFlight()).toBe(2);
    release();
    await h.flush();
    expect(h.shadow.inFlight()).toBe(0);
    expect(h.outcomes).toEqual(['dropped_overload', 'sent', 'sent']);
    expect(serve(h)).toBeDefined();
  });

  it('caps samples per second whatever the in-flight count (encode work is on the event loop)', async () => {
    let t = 0;
    // feed-go answers instantly, so the in-flight cap never binds: only the budget can.
    const h = harness({ config: { maxPerSecond: 3, maxInFlight: 100 }, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(serve(h)).toBeDefined();
      await h.flush();
    }
    expect(h.shadow.inFlight()).toBe(0);
    expect(serve(h)).toBeUndefined();
    expect(h.outcomes).toEqual(['sent', 'sent', 'sent', 'dropped_rate_limit']);
    // A third of a second refills one token (3/s), and no more than one.
    t = 334;
    expect(serve(h)).toBeDefined();
    expect(serve(h)).toBeUndefined();
    // A long idle refills to one second's worth, never beyond it.
    t = 60_000;
    await h.flush();
    expect([serve(h), serve(h), serve(h), serve(h)].filter(Boolean)).toHaveLength(3);
    expect(h.fetchMock).toHaveBeenCalledTimes(4);
  });

  // feed-go's eval capture weighs a sample by 1 / sampleRate (apps/feed-go DESIGN.md §19.6 T1).
  it('every sample carries sampleRate: the configured rate times the share its bounds admitted', async () => {
    let t = 0;
    const h = harness({
      config: { rate: 0.5, maxPerSecond: 10, maxInFlight: 1000 },
      now: () => t,
    });
    const burst = (n: number) => Array.from({ length: n }, () => serve(h)).filter(Boolean).length;
    // 40 selected in one instant: the bucket admits its 10 and drops 30. Each of the 10 is admitted
    // while the window holds fewer than 20 checks, so it carries the configured rate alone.
    expect(burst(40)).toBe(10);
    t = 1_000; // the bucket refills: 41 checks, 11 admitted
    expect(burst(1)).toBe(1);
    t = 70_000; // a new window: the previous one (41, 11) plus this one's; 25 checks, 10 admitted
    expect(burst(25)).toBe(10);
    t = 135_000; // a new window: the previous (25, 10) is still recent; 25 checks, 10 admitted
    expect(burst(25)).toBe(10);
    t = 300_000; // the last window ended over a minute ago: stale, so too few checks again
    expect(burst(1)).toBe(1);
    await h.flush();
    const rates = h.fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse(init.body as string) as { sampleRate: number }).sampleRate
    );
    expect(rates).toHaveLength(32);
    expect(rates.slice(0, 10)).toEqual(Array(10).fill(0.5));
    expect(rates[10]).toBeCloseTo((0.5 * 11) / 41, 12);
    expect(rates[11]).toBeCloseTo((0.5 * 12) / 42, 12);
    expect(rates[21]).toBeCloseTo((0.5 * 11) / 26, 12);
    // Counted with the stale window (25 checks) it would be 0.5 * 11 / 26.
    expect(rates[31]).toBe(0.5);
  });

  it('a budget below one per second still admits one sample', () => {
    const h = harness({ config: { maxPerSecond: 0.1 }, now: () => 0 });
    expect(serve(h)).toBeDefined();
    expect(serve(h)).toBeUndefined();
  });

  it('counts the encode cost it paid, and drops the captured page once encoded', async () => {
    let t = 0;
    const h = harness({ now: () => (t += 5) });
    const sample = serve(h)!;
    expect(sample.captured).toBeDefined();
    await h.flush();
    const body = h.fetchMock.mock.calls[0][1].body as string;
    expect(h.encodes).toEqual([{ seconds: 0.005, bytes: Buffer.byteLength(body) }]);
    expect(sample.captured).toBeUndefined();
  });

  it('skips a non-200 answer and frees the slot', async () => {
    const h = harness();
    serve(h, request(), { status: 500 });
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_status']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('skips when nothing was captured (capture outside the sample scope)', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    h.shadow.capture({ items: [] }, superjson.serialize({ items: [] }), false); // no run() scope
    h.shadow.finish(sample, 200);
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_no_capture']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('pairs each of two interleaved samples with its own input and its own response', async () => {
    const h = harness();
    const procedure = 'image.getImagesAsPostsInfinite';
    const a = h.shadow.begin(request({ query: { trpc: procedure, input: 'input-A' } }))!;
    const b = h.shadow.begin(request({ query: { trpc: procedure, input: 'input-B' } }))!;
    const tick = () => new Promise<void>((r) => setImmediate(r));
    // Both handlers are in flight at once; B began last but serializes FIRST, A serializes after.
    const handlerA = h.shadow.run(a, async () => {
      await tick();
      await tick();
      h.shadow.capture({ page: 'A' }, superjson.serialize({ page: 'A' }), false);
    });
    const handlerB = h.shadow.run(b, async () => {
      await tick();
      h.shadow.capture({ page: 'B' }, superjson.serialize({ page: 'B' }), false);
    });
    await Promise.all([handlerA, handlerB]);
    h.shadow.finish(b, 200);
    h.shadow.finish(a, 200);
    await h.flush();

    const pairs = h.fetchMock.mock.calls
      .map(([, init]) => JSON.parse(init.body as string) as { input: string; node: unknown })
      .map(({ input, node }) => [input, node]);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['input-A', { json: { page: 'A' } }],
        ['input-B', { json: { page: 'B' } }],
      ])
    );
    expect(h.outcomes).toEqual(['sent', 'sent']);
  });

  it('keeps the first capture of a request (one unbatched call serializes one result)', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    h.shadow.run(sample, () => {
      h.shadow.capture({ a: 1 }, superjson.serialize({ a: 1 }), false);
      h.shadow.capture({ a: 2 }, superjson.serialize({ a: 2 }), false);
    });
    h.shadow.finish(sample, 200);
    await h.flush();
    expect(JSON.parse(h.fetchMock.mock.calls[0][1].body as string).node).toEqual({
      json: { a: 1 },
    });
  });

  it('a devalue response is captured by reference and superjson-encoded only at send time', async () => {
    const h = harness();
    const data = { items: [{ at: new Date('2026-02-03T04:05:06.000Z') }] };
    const serialize = vi.spyOn(superjson, 'serialize');
    try {
      serve(h, request(), { data, written: 'DEVALUE-STRING', devalue: true });
      expect(serialize).not.toHaveBeenCalled();
      await h.flush();
      expect(serialize).toHaveBeenCalledTimes(1);
    } finally {
      serialize.mockRestore();
    }
    const node = JSON.parse(h.fetchMock.mock.calls[0][1].body as string).node;
    expect(node).toEqual(JSON.parse(JSON.stringify(superjson.serialize(data))));
    expect(JSON.stringify(node)).not.toContain('DEVALUE-STRING');
  });

  it('counts a non-2xx answer as rejected', async () => {
    const h = harness({ fetchImpl: async () => new Response('no', { status: 503 }) });
    serve(h);
    await h.flush();
    expect(h.outcomes).toEqual(['rejected']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('counts a timeout and a connection error, and never throws', async () => {
    const timeout = harness({
      fetchImpl: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    });
    serve(timeout);
    await timeout.flush();
    expect(timeout.outcomes).toEqual(['timeout']);

    const refused = harness({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    serve(refused);
    await refused.flush();
    expect(refused.outcomes).toEqual(['error']);
    expect(refused.shadow.inFlight()).toBe(0);
  });

  it('a fetch that throws synchronously is counted, not thrown', async () => {
    const h = harness({
      fetchImpl: (() => {
        throw new TypeError('bad url');
      }) as never,
    });
    serve(h);
    await expect(h.flush()).resolves.toBeUndefined();
    expect(h.outcomes).toEqual(['error']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('a payload that cannot be encoded is counted, not thrown', async () => {
    const h = harness();
    serve(h, request(), { written: { json: { n: BigInt(1) } } as never });
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_encode']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('capture is a no-op with no sample in flight', () => {
    const h = harness();
    expect(() => h.shadow.capture({}, {}, false)).not.toThrow();
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('finish twice frees the slot once', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    h.shadow.finish(sample, 500);
    h.shadow.finish(sample, 500);
    expect(h.shadow.inFlight()).toBe(0);
    expect(h.outcomes).toEqual(['skipped_status']);
  });
});

/** A `GET /api/v1/images` request as the Next route receives it. */
function restRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    url: '/api/v1/images?modelVersionId=9&limit=2',
    headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t; x=y', 'cf-ipcountry': 'GB' },
    query: { modelVersionId: '9', limit: '2' },
    ...overrides,
  } as {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    query: Partial<Record<string, string | string[]>>;
  };
}

/** Run one REST request through begin → the handler's capture of its 200 body → finish. */
function serveRest(
  h: ReturnType<typeof harness>,
  req = restRequest(),
  { status = 200, body = { items: [], metadata: {} } as unknown } = {}
) {
  const sample = h.shadow.beginV1Images(req);
  if (sample) {
    if (status === 200) h.shadow.captureV1Images(sample, body);
    h.shadow.finish(sample, status);
  }
  return sample;
}

describe('createFeedGoShadow — GET /api/v1/images', () => {
  it('POSTs the raw query string, the path, the forwarded headers and the JSON body', async () => {
    const h = harness();
    const body = {
      items: [{ id: 11, createdAt: new Date('2024-03-01T10:00:00.000Z'), tags: undefined }],
      metadata: { nextCursor: 'feed:1:2' },
    };
    serveRest(h, restRequest(), { body });
    // Nothing is sent on the request path: only once the scheduled send runs.
    expect(h.fetchMock).not.toHaveBeenCalled();
    await h.flush();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(V1_URL);
    expect(init.method).toBe('POST');
    // The body as res.json writes it: a Date as its ISO string, an undefined member dropped.
    expect(init.body).toBe(
      '{"input":"modelVersionId=9&limit=2","path":"/api/v1/images",' +
        '"headers":{"host":"civitai.com","cf-ipcountry":"GB","cookie":"__Secure-civ-token=t"},' +
        '"node":{"items":[{"id":11,"createdAt":"2024-03-01T10:00:00.000Z"}],' +
        '"metadata":{"nextCursor":"feed:1:2"}},"sampleRate":1}'
    );
    expect(h.outcomes).toEqual(['sent']);
    expect(h.endpoints).toEqual(['v1-images']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('a request with no query string is mirrored with an empty input', async () => {
    const h = harness();
    serveRest(h, restRequest({ url: '/api/v1/images', query: {} }));
    await h.flush();
    expect(JSON.parse(h.fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      input: '',
      path: '/api/v1/images',
    });
  });

  it.each([
    ['its flag off', { v1: false }, restRequest()],
    ['no URL', { config: { v1ImagesUrl: undefined } }, restRequest()],
    ['rate 0', { config: { rate: 0 } }, restRequest()],
    ['not sampled (random >= rate)', { config: { rate: 0.3 }, random: 0.3 }, restRequest()],
    ['a POST', {}, restRequest({ method: 'POST' })],
  ])('does not sample: %s', async (_name, opts, req) => {
    const h = harness(opts as Parameters<typeof harness>[0]);
    expect(serveRest(h, req)).toBeUndefined();
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([]);
  });

  it('each route has its own flag', () => {
    // The gallery flag alone does not sample the REST route...
    const gallery = harness({ enabled: true, v1: false });
    expect(gallery.shadow.beginV1Images(restRequest())).toBeUndefined();
    expect(gallery.shadow.begin(request())).toBeDefined();
    // ...nor the REST flag the gallery procedure.
    const rest = harness({ enabled: false, v1: true });
    expect(rest.shadow.begin(request())).toBeUndefined();
    expect(rest.shadow.beginV1Images(restRequest())).toBeDefined();
  });

  it.each([
    [
      'a bearer header',
      restRequest({ headers: { host: 'civitai.com', authorization: 'Bearer KEY-1' } }),
    ],
    [
      'a ?token= key',
      restRequest({
        url: '/api/v1/images?token=KEY-1&limit=2',
        query: { token: 'KEY-1', limit: '2' },
      }),
    ],
  ])('never mirrors an API credential (%s): counted as skipped_credential', async (_name, req) => {
    const h = harness();
    expect(serveRest(h, req)).toBeUndefined();
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_credential']);
    expect(h.endpoints).toEqual(['v1-images']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('holds no in-flight slot while the handler runs, only once it answered 200', async () => {
    const h = harness();
    const sample = h.shadow.beginV1Images(restRequest())!;
    expect(sample).toBeDefined();
    expect(h.shadow.inFlight()).toBe(0);
    h.shadow.captureV1Images(sample, { items: [], metadata: {} });
    h.shadow.finish(sample, 200);
    expect(h.shadow.inFlight()).toBe(1); // the queued send
    await h.flush();
    expect(h.shadow.inFlight()).toBe(0);
    expect(h.outcomes).toEqual(['sent']);
  });

  it('shares the in-flight cap with the gallery procedure', async () => {
    const h = harness({ config: { maxInFlight: 1 } });
    // A gallery sample holds the only slot (its POST has not settled).
    expect(h.shadow.begin(request())).toBeDefined();
    expect(serveRest(h)).toBeDefined();
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['dropped_overload']);
    expect(h.endpoints).toEqual(['v1-images']);
  });

  it('has its own per-second bucket, so REST samples cannot starve the gallery', async () => {
    const h = harness({ config: { maxPerSecond: 1 }, now: () => 0 });
    // The REST bucket's one token is spent...
    serveRest(h);
    await h.flush();
    expect(h.outcomes).toEqual(['sent']);
    serveRest(h);
    await h.flush();
    expect(h.outcomes).toEqual(['sent', 'dropped_rate_limit']);
    // ...and the gallery procedure's bucket is untouched.
    expect(h.shadow.begin(request())).toBeDefined();
    expect(h.outcomes).toEqual(['sent', 'dropped_rate_limit']);
  });

  it('a non-200 answer is skipped and nothing is sent', async () => {
    const h = harness();
    serveRest(h, restRequest(), { status: 503 });
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_status']);
  });

  it('a capture after a non-200 finish is ignored', async () => {
    const h = harness();
    const sample = h.shadow.beginV1Images(restRequest())!;
    h.shadow.finish(sample, 503);
    h.shadow.captureV1Images(sample, { items: [{ id: 1 }], metadata: {} });
    expect(sample.captured).toBeUndefined();
    // A second finish of the same sample does nothing either.
    h.shadow.finish(sample, 200);
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_status']);
  });

  it('each route captures only its own response', async () => {
    const h = harness();
    // A gallery sample held open keeps inFlight > 0, so the transformer's capture gets past its
    // "nothing in flight" shortcut and only the endpoint guard can refuse the REST sample.
    const g = h.shadow.begin(request())!;
    expect(h.shadow.inFlight()).toBe(1);
    const sample = h.shadow.beginV1Images(restRequest())!;
    h.shadow.run(sample, () =>
      h.shadow.capture({ items: [] }, superjson.serialize({ items: [] }), false)
    );
    expect(sample.captured).toBeUndefined();
    h.shadow.finish(sample, 200);
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_no_capture']);
    // And the other way round: a gallery sample ignores the REST capture.
    h.shadow.captureV1Images(g, { items: [] });
    h.shadow.finish(g, 200);
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_no_capture', 'skipped_no_capture']);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

/** A model-route request as the Next route receives it (`/api/v1/models` or `/api/v1/models/[id]`). */
function modelsRequest(url: string, overrides: Record<string, unknown> = {}) {
  return restRequest({ url, query: {}, ...overrides });
}

describe('createFeedGoShadow — GET /api/v1/models and /api/v1/models/[id]', () => {
  function serveModels(
    h: ReturnType<typeof harness>,
    endpoint: 'v1-models' | 'v1-models-id',
    req: ReturnType<typeof restRequest>,
    { status = 200, body = { items: [], metadata: {} } as unknown } = {},
    opts?: RestSampleOptions
  ) {
    const sample = h.shadow.beginRest(endpoint, req, opts);
    if (sample) {
      if (status === 200) h.shadow.captureRest(sample, body);
      h.shadow.finish(sample, status);
    }
    return sample;
  }

  it('the list: POSTs its query string, path, headers and JSON body to the models compare path', async () => {
    const h = harness();
    const body = {
      items: [{ id: 5001, name: 'A', mode: undefined, stats: { downloadCount: null } }],
      metadata: { nextCursor: '7|5001', nextPage: undefined },
    };
    serveModels(h, 'v1-models', modelsRequest('/api/v1/models?limit=1&sort=Newest'), { body });
    expect(h.fetchMock).not.toHaveBeenCalled();
    await h.flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(V1_MODELS_URL);
    expect(init.body).toBe(
      '{"input":"limit=1&sort=Newest","path":"/api/v1/models",' +
        '"headers":{"host":"civitai.com","cf-ipcountry":"GB","cookie":"__Secure-civ-token=t"},' +
        '"node":{"items":[{"id":5001,"name":"A","stats":{"downloadCount":null}}],' +
        '"metadata":{"nextCursor":"7|5001"}},"sampleRate":1}'
    );
    expect(h.outcomes).toEqual(['sent']);
    expect(h.endpoints).toEqual(['v1-models']);
  });

  it('one model: POSTs the path (the id) with an empty input to the id compare path', async () => {
    const h = harness();
    serveModels(h, 'v1-models-id', modelsRequest('/api/v1/models/42'), { body: { id: 42 } });
    await h.flush();
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(V1_MODEL_ID_URL);
    expect(JSON.parse(init.body as string)).toEqual({
      input: '',
      path: '/api/v1/models/42',
      headers: { host: 'civitai.com', 'cf-ipcountry': 'GB', cookie: '__Secure-civ-token=t' },
      node: { id: 42 },
      sampleRate: 1,
    });
    expect(h.endpoints).toEqual(['v1-models-id']);
  });

  it("a model sample carries the Training Data statement hash; another route's does not", async () => {
    const hash = { [FEED_GO_TRAINING_DATA_SQL_HEADER]: 'abc123' };
    const h = harness({ modelSampleHeaders: () => hash });
    serveModels(h, 'v1-models', modelsRequest('/api/v1/models?limit=1'));
    serveModels(h, 'v1-models-id', modelsRequest('/api/v1/models/42'), { body: { id: 42 } });
    const img = h.shadow.beginV1Images(restRequest());
    if (img) {
      h.shadow.captureV1Images(img, { items: [] });
      h.shadow.finish(img, 200);
    }
    await h.flush();
    const headers = h.fetchMock.mock.calls.map(
      ([url, init]) => [url, JSON.parse(init.body as string).headers] as const
    );
    expect(headers.filter(([url]) => url === V1_MODELS_URL || url === V1_MODEL_ID_URL)).toEqual([
      [V1_MODELS_URL, expect.objectContaining(hash)],
      [V1_MODEL_ID_URL, expect.objectContaining(hash)],
    ]);
    const others = headers.filter(([url]) => url !== V1_MODELS_URL && url !== V1_MODEL_ID_URL);
    expect(others).toHaveLength(1);
    expect(others[0][1]).not.toHaveProperty(FEED_GO_TRAINING_DATA_SQL_HEADER);
    // A source that throws leaves the header off (feed-go then falls back on Training Data).
    const broken = harness({
      modelSampleHeaders: () => {
        throw new Error('x');
      },
    });
    const s = broken.shadow.beginRest('v1-models', modelsRequest('/api/v1/models'));
    expect(s?.headers).not.toHaveProperty(FEED_GO_TRAINING_DATA_SQL_HEADER);
  });

  it('a list text query is sampled only with FEED_GO_SHADOW_V1_MODELS_QUERY; an empty one always', () => {
    const text = (q: string | string[]) =>
      modelsRequest(`/api/v1/models?query=${encodeURIComponent(String(q))}`, {
        query: { query: q },
      });
    const off = harness();
    expect(off.shadow.beginRest('v1-models', text('cat'))).toBeUndefined();
    expect(off.shadow.beginRest('v1-models', text(' '))).toBeUndefined();
    expect(off.shadow.beginRest('v1-models', text(['', '']))).toBeUndefined();
    // The empty query is the database path: sampled as before.
    expect(off.shadow.beginRest('v1-models', text(''))).toBeDefined();
    // `[id]` has no text search: a `query` key there changes nothing.
    expect(
      off.shadow.beginRest(
        'v1-models-id',
        modelsRequest('/api/v1/models/1', { query: { query: 'x' } })
      )
    ).toBeDefined();
    const on = harness({ config: { v1ModelsQuery: true } });
    const sample = on.shadow.beginRest('v1-models', text('cat'));
    expect(sample).toBeDefined();
    expect(sample?.input).toBe('query=cat');
  });

  it('one flag covers both model routes, and neither the images nor the gallery flag does', () => {
    const off = harness({ v1Models: false });
    expect(off.shadow.beginRest('v1-models', modelsRequest('/api/v1/models'))).toBeUndefined();
    expect(off.shadow.beginRest('v1-models-id', modelsRequest('/api/v1/models/1'))).toBeUndefined();
    expect(off.shadow.beginV1Images(restRequest())).toBeDefined();
    expect(off.shadow.begin(request())).toBeDefined();
    const on = harness({ enabled: false, v1: false, v1Models: true });
    expect(on.shadow.beginRest('v1-models', modelsRequest('/api/v1/models'))).toBeDefined();
    expect(on.shadow.beginRest('v1-models-id', modelsRequest('/api/v1/models/1'))).toBeDefined();
    expect(on.shadow.beginV1Images(restRequest())).toBeUndefined();
    expect(on.shadow.begin(request())).toBeUndefined();
  });

  it.each([
    ['the list', 'v1-models', { config: { v1ModelsUrl: undefined } }],
    ['one model', 'v1-models-id', { config: { v1ModelsIdUrl: undefined } }],
  ] as const)('%s is not sampled without its compare URL', (_name, endpoint, opts) => {
    const h = harness(opts as Parameters<typeof harness>[0]);
    expect(h.shadow.beginRest(endpoint, modelsRequest('/api/v1/models/1'))).toBeUndefined();
  });

  it.each(['v1-models', 'v1-models-id'] as const)(
    '%s never mirrors an API credential: counted under its own endpoint',
    async (endpoint) => {
      const h = harness();
      const req = modelsRequest('/api/v1/models?token=KEY-2', { query: { token: 'KEY-2' } });
      expect(serveModels(h, endpoint, req)).toBeUndefined();
      await h.flush();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual(['skipped_credential']);
      expect(h.endpoints).toEqual([endpoint]);
    }
  );

  describe('an API credential, with FEED_GO_SHADOW_V1_MODELS_CREDENTIALS', () => {
    const KEY = 'k-live-secret-0123';
    const DESCRIBED = 'key:described';
    const keyed = (url: string, headers: Record<string, string> = {}) =>
      modelsRequest(url, {
        headers: { host: 'civitai.com', authorization: `Bearer ${KEY}`, ...headers },
      });

    it.each(['v1-models', 'v1-models-id'] as const)(
      'off (the default): %s is counted skipped_credential and never sent, as before',
      async (endpoint) => {
        const h = harness();
        expect(
          serveModels(h, endpoint, keyed('/api/v1/models/1'), {}, { credential: () => DESCRIBED })
        ).toBeUndefined();
        await h.flush();
        expect(h.fetchMock).not.toHaveBeenCalled();
        expect(h.outcomes).toEqual(['skipped_credential']);
      }
    );

    it('on: [id] is sent with the description in place of the key', async () => {
      const h = harness({ config: { v1ModelsCredentials: true } });
      const sample = serveModels(
        h,
        'v1-models-id',
        keyed('/api/v1/models/1'),
        { body: { id: 1 } },
        { credential: () => DESCRIBED }
      );
      expect(sample).toBeDefined();
      await h.flush();
      expect(h.outcomes).toEqual(['sent']);
      const [url, init] = h.fetchMock.mock.calls[0];
      expect(url).toBe(V1_MODEL_ID_URL);
      const body = init.body as string;
      expect(JSON.parse(body).headers).toEqual({
        host: 'civitai.com',
        authorization: 'present',
        'x-feed-go-credential': DESCRIBED,
      });
      expect(body).not.toContain(KEY);
    });

    it.each([
      [
        'the list (its credentials always fall back in feed-go)',
        'v1-models',
        keyed('/api/v1/models'),
      ],
      [
        'a ?token= on [id] (the query string carries it)',
        'v1-models-id',
        modelsRequest('/api/v1/models/1?token=KEY', { query: { token: 'KEY' } }),
      ],
      ['GET /api/v1/images', 'v1-images', keyed('/api/v1/images')],
    ] as const)('on: %s is still skipped_credential', async (_name, endpoint, req) => {
      const h = harness({ config: { v1ModelsCredentials: true } });
      const sample =
        endpoint === 'v1-images'
          ? h.shadow.beginV1Images(req)
          : h.shadow.beginRest(endpoint, req, { credential: () => DESCRIBED });
      expect(sample).toBeUndefined();
      await h.flush();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual(['skipped_credential']);
    });

    it('on: no description, an empty one or a throwing one is skipped_credential', async () => {
      const h = harness({ config: { v1ModelsCredentials: true } });
      for (const credential of [
        undefined,
        () => undefined,
        () => {
          throw new Error('x');
        },
      ]) {
        expect(
          h.shadow.beginRest('v1-models-id', keyed('/api/v1/models/1'), { credential })
        ).toBeUndefined();
      }
      await h.flush();
      expect(h.outcomes).toEqual([
        'skipped_credential',
        'skipped_credential',
        'skipped_credential',
      ]);
    });

    it('on: a request with no credential carries no description', async () => {
      const h = harness({ config: { v1ModelsCredentials: true } });
      serveModels(
        h,
        'v1-models-id',
        modelsRequest('/api/v1/models/1', { headers: { host: 'civitai.com' } }),
        { body: { id: 1 } },
        { credential: () => DESCRIBED }
      );
      await h.flush();
      const [, init] = h.fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string).headers).toEqual({ host: 'civitai.com' });
    });
  });

  describe('corpus-only samples, with FEED_GO_SHADOW_CORPUS_ONLY_RATE', () => {
    // A distinctive synthetic key: it must appear nowhere in what is sent. It holds no credential
    // word, so a pair echoing it is dropped for holding the key, not for its spelling.
    const KEY = 'zq7-synthetic-K3y-Hc93x'; // gitleaks:allow synthetic test key
    const onlyHeaders = { host: 'civitai.com', 'cf-ipcountry': 'GB' };
    const keyedHeaders = (extra: Record<string, string> = {}) => ({
      ...onlyHeaders,
      cookie: '__Secure-civ-token=session-value; theme=dark',
      ...extra,
    });
    const bearer = { authorization: `Bearer ${KEY}` };

    /** Every string the fetch mock was called with: the URL, the headers and the body. */
    function sentText(h: ReturnType<typeof harness>) {
      return h.fetchMock.mock.calls
        .map(([url, init]) =>
          [url, JSON.stringify(init.headers ?? {}), String(init.body)].join('\n')
        )
        .join('\n');
    }

    it.each([
      [
        'an Authorization bearer header',
        modelsRequest('/api/v1/models/1?limit=1', {
          headers: keyedHeaders(bearer),
          query: { id: '1', limit: '1' },
        }),
        'header',
      ],
      [
        'a ?token= key',
        modelsRequest(`/api/v1/models/1?token=${KEY}&limit=1`, {
          headers: keyedHeaders(),
          query: { id: '1', token: KEY, limit: '1' },
        }),
        'query',
      ],
      [
        // `Token` is not a credential to the app (it reads `token`), so alone it is an ordinary
        // sample; beside a bearer header it is still taken out.
        'a bearer header and the key under ?Token=',
        modelsRequest(`/api/v1/models/1?Token=${KEY}&limit=1`, {
          headers: keyedHeaders(bearer),
          query: { id: '1', Token: KEY, limit: '1' },
        }),
        'header',
      ],
      [
        'a percent-encoded %74oken= key',
        modelsRequest(`/api/v1/models/1?%74oken=${KEY}&limit=1`, {
          headers: keyedHeaders(),
          query: { id: '1', token: KEY, limit: '1' },
        }),
        'query',
      ],
      [
        'a bearer header and the key echoed under an ordinary name',
        modelsRequest(`/api/v1/models/1?limit=1&note=${KEY}`, {
          headers: keyedHeaders(bearer),
          query: { id: '1', limit: '1', note: KEY },
        }),
        'header',
      ],
      [
        // URLSearchParams decodes each valid escape and keeps the bad trailing `%`, so the reader
        // sees the key in this value although decodeURIComponent gives up on it.
        'a bearer header and the key behind an escape and a bad escape',
        modelsRequest(`/api/v1/models/1?limit=1&note=%7A${KEY.slice(1)}%`, {
          headers: keyedHeaders(bearer),
          query: { id: '1', limit: '1', note: `${KEY}%` },
        }),
        'header',
      ],
      [
        'a ?token= key echoed in another query value',
        modelsRequest(`/api/v1/models/1?token=${KEY}&limit=1&note=${KEY}`, {
          headers: keyedHeaders(),
          query: { id: '1', token: KEY, limit: '1', note: KEY },
        }),
        'query',
      ],
    ] as const)(
      '%s: posted with the credential taken out, its class, sampleRate and no Node answer',
      async (_name, req, credential) => {
        const h = harness({ config: { corpusOnlyRate: 0.5 } });
        // The handler gets no sample: Node's answer is never captured or waited for.
        expect(h.shadow.beginRest('v1-models-id', req)).toBeUndefined();
        expect(h.fetchMock).not.toHaveBeenCalled();
        await h.flush();
        expect(h.fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = h.fetchMock.mock.calls[0];
        expect(url).toBe(V1_MODEL_ID_URL);
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
          corpusOnly: true,
          credential,
          sampleRate: 0.5,
          input: 'limit=1',
          path: '/api/v1/models/1',
          headers: onlyHeaders,
        });
        expect(body).not.toHaveProperty('node');
        expect(body).not.toHaveProperty('responseHeaders');
        const sent = sentText(h);
        expect(sent).not.toContain(KEY);
        expect(sent).not.toContain('session-value');
        expect(sent).not.toContain('x-feed-go-credential');
        expect(h.outcomes).toEqual(['corpus_only']);
        expect(h.endpoints).toEqual(['v1-models-id']);
        expect(h.shadow.inFlight()).toBe(0);
      }
    );

    const keyed = modelsRequest('/api/v1/models/1', {
      headers: keyedHeaders(bearer),
      query: { id: '1' },
    });

    it.each([
      ['off (the default)', {}],
      ['rate 0', { corpusOnlyRate: 0 }],
    ] as const)('%s: still skipped_credential, nothing sent', async (_name, cfg) => {
      const h = harness({ config: cfg });
      expect(h.shadow.beginRest('v1-models-id', keyed)).toBeUndefined();
      await h.flush();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual(['skipped_credential']);
    });

    it('a request whose kept headers hold the key is not sent: skipped_credential', async () => {
      const h = harness({ config: { corpusOnlyRate: 1 } });
      const req = modelsRequest('/api/v1/models/1', {
        headers: { ...keyedHeaders(bearer), host: `${KEY}.example` },
        query: { id: '1' },
      });
      expect(h.shadow.beginRest('v1-models-id', req)).toBeUndefined();
      await h.flush();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual(['skipped_credential']);
    });

    // All three factors distinct: base rate 0.4, admitted share 6/26, corpus-only rate 0.5.
    it('sampleRate is the base rate times the [id] bucket share times the corpus-only rate', async () => {
      let t = 0;
      const h = harness({
        config: { rate: 0.4, corpusOnlyRate: 0.5, maxPerSecond: 5, maxInFlight: 1000 },
        now: () => t,
      });
      // 25 in one instant: the bucket admits 5 (each under 20 checks: 0.4 x 0.5) and drops 20.
      for (let i = 0; i < 25; i++) h.shadow.beginRest('v1-models-id', keyed);
      t = 1_000; // refilled: 26 checks, 6 admitted
      h.shadow.beginRest('v1-models-id', keyed);
      await h.flush();
      const rates = h.fetchMock.mock.calls.map(
        ([, init]) => (JSON.parse(init.body as string) as { sampleRate: number }).sampleRate
      );
      expect(rates).toHaveLength(6);
      expect(rates.slice(0, 5)).toEqual(Array(5).fill(0.4 * 0.5));
      expect(rates[5]).toBeCloseTo(0.4 * (6 / 26) * 0.5, 12);
      expect(h.outcomes.filter((o) => o === 'dropped_rate_limit')).toHaveLength(20);
      expect(h.outcomes.filter((o) => o === 'corpus_only')).toHaveLength(6);
    });

    it('not picked at its rate: skipped_credential', async () => {
      const h = harness({ config: { corpusOnlyRate: 0.5 }, random: 0.5 });
      expect(h.shadow.beginRest('v1-models-id', keyed)).toBeUndefined();
      await h.flush();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual(['skipped_credential']);
    });

    it.each([
      ['the list', 'v1-models', modelsRequest('/api/v1/models', { headers: keyedHeaders(bearer) })],
      ['GET /api/v1/images', 'v1-images', restRequest({ headers: keyedHeaders(bearer) })],
      [
        '[id] with a bearer header and a ?token= at once',
        'v1-models-id',
        modelsRequest(`/api/v1/models/1?token=${KEY}`, {
          headers: keyedHeaders(bearer),
          query: { id: '1', token: KEY },
        }),
      ],
    ] as const)('%s: unchanged, skipped_credential', async (_name, endpoint, req) => {
      const h = harness({ config: { corpusOnlyRate: 1 } });
      expect(h.shadow.beginRest(endpoint, req)).toBeUndefined();
      await h.flush();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual(['skipped_credential']);
      expect(h.endpoints).toEqual([endpoint]);
    });

    it('takes the shared in-flight cap and the [id] bucket like a sample', async () => {
      const full = harness({ config: { corpusOnlyRate: 1, maxInFlight: 1 } });
      // A gallery sample holds the only slot.
      expect(full.shadow.begin(request())).toBeDefined();
      expect(full.shadow.beginRest('v1-models-id', keyed)).toBeUndefined();
      await full.flush();
      expect(full.fetchMock).not.toHaveBeenCalled();
      expect(full.outcomes).toEqual(['dropped_overload']);

      const h = harness({ config: { corpusOnlyRate: 1, maxPerSecond: 1 }, now: () => 0 });
      h.shadow.beginRest('v1-models-id', keyed);
      await h.flush();
      h.shadow.beginRest('v1-models-id', keyed);
      await h.flush();
      expect(h.outcomes).toEqual(['corpus_only', 'dropped_rate_limit']);
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('each model route has its own per-second bucket', async () => {
    const h = harness({ config: { maxPerSecond: 1 }, now: () => 0 });
    serveModels(h, 'v1-models', modelsRequest('/api/v1/models'));
    await h.flush();
    serveModels(h, 'v1-models', modelsRequest('/api/v1/models'));
    await h.flush();
    expect(h.outcomes).toEqual(['sent', 'dropped_rate_limit']);
    // The id route's bucket and the images route's are untouched.
    serveModels(h, 'v1-models-id', modelsRequest('/api/v1/models/1'));
    serveRest(h);
    await h.flush();
    expect(h.outcomes).toEqual(['sent', 'dropped_rate_limit', 'sent', 'sent']);
    expect(h.endpoints).toEqual(['v1-models', 'v1-models', 'v1-models-id', 'v1-images']);
  });

  it('a model sample ignores the tRPC capture, and a gallery sample the REST capture', async () => {
    const h = harness();
    const g = h.shadow.begin(request())!;
    const m = h.shadow.beginRest('v1-models', modelsRequest('/api/v1/models'))!;
    h.shadow.run(m, () => h.shadow.capture({ a: 1 }, superjson.serialize({ a: 1 }), false));
    expect(m.captured).toBeUndefined();
    h.shadow.captureRest(g, { items: [] });
    expect(g.captured).toBeUndefined();
  });
});

describe('createFeedGoShadow — image.getInfinite', () => {
  const infiniteRequest = (overrides: Record<string, unknown> = {}) =>
    request({ query: { trpc: 'image.getInfinite', input: INPUT }, ...overrides });

  it('POSTs the raw input, the forwarded headers and the written envelope to its own path', async () => {
    const h = harness({ enabled: false, infinite: true });
    const data = {
      items: [{ id: 8001, createdAt: new Date('2026-01-02T00:00:00.000Z') }],
      source: 'feed',
    };
    const written = superjson.serialize(data);
    const sample = serve(
      h,
      infiniteRequest({ headers: { host: 'civitai.com', cookie: 'a=b; __Secure-civ-token=t' } }),
      { data, written }
    );
    expect(sample?.endpoint).toBe('infinite');
    await h.flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(INF_URL);
    expect(JSON.parse(init.body as string)).toEqual({
      input: INPUT,
      headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t' },
      node: JSON.parse(JSON.stringify(written)),
      sampleRate: 1,
    });
    expect(h.outcomes).toEqual(['sent']);
    expect(h.endpoints).toEqual(['infinite']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('has its own flag: the gallery flag does not sample it, nor its flag the gallery', () => {
    const gallery = harness({ enabled: true, infinite: false });
    expect(gallery.shadow.begin(infiniteRequest())).toBeUndefined();
    expect(gallery.shadow.begin(request())?.endpoint).toBe('as-posts');
    const infinite = harness({ enabled: false, infinite: true });
    expect(infinite.shadow.begin(request())).toBeUndefined();
    expect(infinite.shadow.begin(infiniteRequest())?.endpoint).toBe('infinite');
  });

  it('shares the in-flight cap with the gallery procedure', async () => {
    const h = harness({ infinite: true, config: { maxInFlight: 1 } });
    expect(h.shadow.begin(request())).toBeDefined();
    expect(h.shadow.begin(infiniteRequest())).toBeUndefined();
    expect(h.outcomes).toEqual(['dropped_overload']);
    expect(h.endpoints).toEqual(['infinite']);
  });

  it('has its own per-second bucket, so it cannot starve the gallery', async () => {
    const h = harness({ infinite: true, config: { maxPerSecond: 1 }, now: () => 0 });
    serve(h, infiniteRequest());
    await h.flush();
    serve(h, infiniteRequest());
    await h.flush();
    expect(h.outcomes).toEqual(['sent', 'dropped_rate_limit']);
    expect(h.endpoints).toEqual(['infinite', 'infinite']);
    // The gallery procedure's bucket is untouched.
    expect(h.shadow.begin(request())?.endpoint).toBe('as-posts');
  });

  it('a non-200 answer is skipped and frees the slot', async () => {
    const h = harness({ infinite: true });
    serve(h, infiniteRequest(), { status: 400 });
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_status']);
    expect(h.endpoints).toEqual(['infinite']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('ignores the REST capture (a tRPC sample is captured by the transformer)', async () => {
    const h = harness({ infinite: true });
    const sample = h.shadow.begin(infiniteRequest())!;
    h.shadow.captureV1Images(sample, { items: [] });
    h.shadow.finish(sample, 200);
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_no_capture']);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('feedGoV1ShapeClass', () => {
  const req = restRequest();
  it.each([
    ['a plain gallery page', { modelVersionId: 9 }, 200, 'ported'],
    ['modelId with a version', { modelId: 3, modelVersionId: 9 }, 200, 'ported'],
    ['an id batch', { ids: [1, 2] }, 200, 'ported'],
    ['an id batch with meta', { ids: [1, 2], withMeta: true }, 200, 'ported'],
    ['an id batch for one image', { ids: [1], imageId: 5 }, 200, 'unported_imageId'],
    [
      'an id batch under a model without a version',
      { ids: [1], modelId: 3 },
      200,
      'unported_modelId_only',
    ],
    ['one image', { imageId: 5 }, 200, 'unported_imageId'],
    ['a model without a version', { modelId: 3 }, 200, 'unported_modelId_only'],
    ['tags', { tags: [5] }, 200, 'unported_tags'],
    ['base models', { baseModels: ['SDXL 1.0'] }, 200, 'unported_baseModels'],
    ['meta', { withMeta: true }, 200, 'ported'],
    ['tags on images', { withTags: true }, 200, 'unported_withTags'],
    ['tags on images with meta', { withTags: true, withMeta: true }, 200, 'unported_withTags'],
    ['a 503', { modelVersionId: 9 }, 503, 'non200'],
  ] as const)('%s is %s', (_name, data, status, want) => {
    expect(feedGoV1ShapeClass(req, data, status)).toBe(want);
  });

  // zod strips a key outside imagesEndpointSchema, so the parsed data never shows one: the class is
  // read from the raw query, in ParseV1's order (after imageId/tags/baseModels, before the rest).
  it.each([
    [
      'an unknown key',
      { modelVersionId: '9', utm_source: 'x' },
      { modelVersionId: 9 },
      'unported_unknownKey',
    ],
    ['an unknown key with no value', { ids: '1', foo: '' }, { ids: [1] }, 'unported_unknownKey'],
    ['the API key alone is not unknown', { token: 'K' }, {}, 'api_key'],
    [
      'schema keys only',
      { modelVersionId: '9', limit: '2', sort: 'Newest' },
      { modelVersionId: 9 },
      'ported',
    ],
    ['tags wins over an unknown key', { tags: '5', foo: '1' }, { tags: [5] }, 'unported_tags'],
    [
      'imageId wins over an unknown key',
      { imageId: '3', foo: '1' },
      { imageId: 3 },
      'unported_imageId',
    ],
    [
      'an unknown key wins over a model without a version',
      { modelId: '3', foo: '1' },
      { modelId: 3 },
      'unported_unknownKey',
    ],
    [
      'an unknown key wins over withTags',
      { withTags: 'true', foo: '1' },
      { withTags: true },
      'unported_unknownKey',
    ],
  ] as const)('raw query: %s is %s', (_name, query, data, want) => {
    expect(feedGoV1ShapeClass(restRequest({ query }), data, 200)).toBe(want);
  });

  // The seam with feed-go: every key of the generated allow-list Go reads (schemas.json) is accepted
  // here too, so the two cannot disagree about which query keys are unknown.
  it('accepts every key of the allow-list feed-go embeds', () => {
    const embedded = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../apps/feed-go/internal/inputschema/schemas.json'),
        'utf8'
      )
    ) as { imagesEndpointSchema: { keys: string[] } };
    expect(embedded.imagesEndpointSchema.keys.length).toBe(21);
    for (const key of embedded.imagesEndpointSchema.keys) {
      expect([key, feedGoV1ShapeClass(restRequest({ query: { [key]: '1' } }), {}, 200)]).toEqual([
        key,
        'ported',
      ]);
    }
  });

  it('a query that did not parse is non200, an API credential is api_key', () => {
    expect(feedGoV1ShapeClass(req, null, 200)).toBe('non200');
    expect(
      feedGoV1ShapeClass(restRequest({ headers: { authorization: 'Bearer K' } }), {}, 200)
    ).toBe('api_key');
    expect(feedGoV1ShapeClass(restRequest({ query: { token: 'K' } }), { ids: [1] }, 200)).toBe(
      'api_key'
    );
  });
});

describe('createFeedGoShadow — model.getAll', () => {
  const modelsRequest = (overrides: Record<string, unknown> = {}) =>
    request({ query: { trpc: 'model.getAll', input: INPUT }, ...overrides });

  it('POSTs the raw input, the forwarded headers and the written envelope to its own path', async () => {
    const h = harness({ enabled: false, models: true });
    const data = {
      items: [{ id: 5001, createdAt: new Date('2026-01-02T00:00:00.000Z') }],
      nextCursor: '12|5001',
    };
    const written = superjson.serialize(data);
    const sample = serve(
      h,
      modelsRequest({ headers: { host: 'civitai.com', cookie: 'a=b; __Secure-civ-token=t' } }),
      { data, written }
    );
    expect(sample?.endpoint).toBe('model-getall');
    await h.flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(MODELS_URL);
    expect(url.endsWith(FEED_GO_SHADOW_MODEL_GET_ALL_PATH)).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      input: INPUT,
      headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t' },
      node: JSON.parse(JSON.stringify(written)),
      sampleRate: 1,
    });
    expect(h.outcomes).toEqual(['sent']);
    expect(h.endpoints).toEqual(['model-getall']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('a devalue response is superjson-encoded at send time', async () => {
    const h = harness({ enabled: false, models: true });
    const data = { items: [{ id: 5001, lastVersionAt: new Date('2026-01-03T00:00:00.000Z') }] };
    serve(h, modelsRequest(), { data, written: 'devalue-string', devalue: true });
    await h.flush();
    const [, init] = h.fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string).node).toEqual(
      JSON.parse(JSON.stringify(superjson.serialize(data)))
    );
  });

  it('has its own flag: the gallery flag does not sample it, nor its flag the gallery', () => {
    const gallery = harness({ enabled: true, models: false });
    expect(gallery.shadow.begin(modelsRequest())).toBeUndefined();
    expect(gallery.shadow.begin(request())?.endpoint).toBe('as-posts');
    const models = harness({ enabled: false, models: true });
    expect(models.shadow.begin(request())).toBeUndefined();
    expect(models.shadow.begin(modelsRequest())?.endpoint).toBe('model-getall');
  });

  it('shares the in-flight cap with the gallery procedure', () => {
    const h = harness({ models: true, config: { maxInFlight: 1 } });
    expect(h.shadow.begin(request())).toBeDefined();
    expect(h.shadow.begin(modelsRequest())).toBeUndefined();
    expect(h.outcomes).toEqual(['dropped_overload']);
    expect(h.endpoints).toEqual(['model-getall']);
  });

  it('has its own per-second bucket, so it cannot starve the gallery', async () => {
    const h = harness({ models: true, config: { maxPerSecond: 1 }, now: () => 0 });
    serve(h, modelsRequest());
    await h.flush();
    serve(h, modelsRequest());
    await h.flush();
    expect(h.outcomes).toEqual(['sent', 'dropped_rate_limit']);
    expect(h.endpoints).toEqual(['model-getall', 'model-getall']);
    // The gallery procedure's bucket is untouched.
    expect(h.shadow.begin(request())?.endpoint).toBe('as-posts');
  });

  it('a non-200 answer is skipped and frees the slot', async () => {
    const h = harness({ models: true });
    serve(h, modelsRequest(), { status: 400 });
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_status']);
    expect(h.endpoints).toEqual(['model-getall']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('ignores the REST capture (a tRPC sample is captured by the transformer)', async () => {
    const h = harness({ models: true });
    const sample = h.shadow.begin(modelsRequest())!;
    h.shadow.captureV1Images(sample, { items: [] });
    h.shadow.finish(sample, 200);
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_no_capture']);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('createFeedGoShadow — REST response headers', () => {
  // What a REST route's response holds after res.json: the wrapper's and handler's headers, Next's
  // ETag and Content-Type, the router's config headers, the proxy's X-Handled-By.
  const restResponse = () => ({
    getHeaders: () => ({
      'x-frame-options': 'DENY',
      'x-handled-by': 'pod-a',
      vary: 'Authorization',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type, *',
      'access-control-allow-methods': 'GET',
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=150',
      etag: '"abc123"',
      'content-type': 'application/json; charset=utf-8',
      'content-length': 42,
    }),
  });

  it('both lists are the ones feed-go compares (shadow.ComparedHeaders / RESTComparedHeaders)', () => {
    // Read from the Go source, so a header added on either side without the other fails here: one
    // Node forwards that Go never compares is dead weight, one Go compares that Node never sends
    // reads as missing-in-node on every sample.
    const src = readFileSync(
      join(process.cwd(), 'apps/feed-go/internal/shadow/response.go'),
      'utf8'
    );
    const names = (text: string | undefined) =>
      [...(text ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const base = names(/var ComparedHeaders = \[\]string\{([^}]*)\}/.exec(src)?.[1]);
    const extras = names(
      /var RESTComparedHeaders = append\(slices\.Clone\(ComparedHeaders\),([^)]*)\)/.exec(src)?.[1]
    );
    expect(base.length).toBeGreaterThan(0);
    expect(extras.length).toBeGreaterThan(0);
    expect([...FEED_GO_COMPARED_RESPONSE_HEADERS]).toEqual(base);
    expect([...FEED_GO_COMPARED_REST_RESPONSE_HEADERS]).toEqual([...base, ...extras]);
  });

  it.each([
    ['v1-models', '/api/v1/models?limit=1', V1_MODELS_URL],
    ['v1-models-id', '/api/v1/models/42', V1_MODEL_ID_URL],
  ] as const)(
    '%s posts the REST header list, marked rest, and nothing transport or per-pod',
    async (endpoint, url, compareUrl) => {
      const h = harness();
      const sample = h.shadow.beginRest(endpoint, modelsRequest(url))!;
      h.shadow.captureRest(sample, { id: 42 });
      h.shadow.finish(sample, 200, restResponse());
      await h.flush();
      const [posted, init] = h.fetchMock.mock.calls[0];
      expect(posted).toBe(compareUrl);
      const body = JSON.parse(init.body as string);
      expect(body.responseHeaderSet).toBe('rest');
      expect(body.responseHeaders).toEqual({
        'x-frame-options': 'DENY',
        vary: 'Authorization',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type, *',
        'access-control-allow-methods': 'GET',
        'cache-control': 'public, s-maxage=300, stale-while-revalidate=150',
        etag: '"abc123"',
      });
    }
  );

  it('a tRPC sample keeps the base list and no set marker', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    const data = { items: [] };
    h.shadow.run(sample, () => h.shadow.capture(data, superjson.serialize(data), false));
    h.shadow.finish(sample, 200, restResponse());
    await h.flush();
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('responseHeaderSet');
    expect(body.responseHeaders).toEqual({
      vary: 'Authorization',
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=150',
    });
  });

  /**
   * A response that has not sent its headers when the route's `finally` calls `finish` (the endpoint
   * wrappers' withAxiom runs Next's res.json later), emitting `finish` / `close` when told to.
   */
  function pendingResponse() {
    const emitter = new EventEmitter();
    const headers: Record<string, string> = { 'cache-control': 'private, no-store' };
    const res = {
      statusCode: 200,
      headersSent: false,
      getHeaders: () => ({ ...headers }),
      once: (event: 'finish' | 'close', listener: () => void) => emitter.once(event, listener),
    };
    return { res, headers, emit: (event: 'finish' | 'close') => emitter.emit(event) };
  }

  it('a REST response not yet sent is read on finish: the ETag set after the handler is in the sample', async () => {
    const h = harness();
    const sample = h.shadow.beginRest('v1-models-id', modelsRequest('/api/v1/models/42'))!;
    h.shadow.captureRest(sample, { id: 42 });
    const p = pendingResponse();
    h.shadow.finish(sample, 200, p.res);
    // Nothing is read or queued before the response goes out, but the slot is already held.
    expect(h.queued).toHaveLength(0);
    expect(h.shadow.inFlight()).toBe(1);
    // What Next's res.json sets when it finally runs.
    p.headers.etag = '"later-etag"';
    p.res.headersSent = true;
    p.emit('finish');
    p.emit('close');
    await h.flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body.responseHeaders).toEqual({
      'cache-control': 'private, no-store',
      etag: '"later-etag"',
    });
    expect(h.outcomes).toEqual(['sent']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('a REST response that finishes with a 304 (Next answering If-None-Match) is skipped_status', async () => {
    const h = harness();
    const sample = h.shadow.beginRest('v1-models', modelsRequest('/api/v1/models?limit=1'))!;
    h.shadow.captureRest(sample, { items: [], metadata: {} });
    const p = pendingResponse();
    h.shadow.finish(sample, 200, p.res);
    p.res.statusCode = 304;
    p.emit('finish');
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_status']);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('a REST response that closes without finishing (a client abort) is skipped_status and frees the slot', async () => {
    const h = harness();
    const sample = h.shadow.beginRest('v1-models-id', modelsRequest('/api/v1/models/42'))!;
    h.shadow.captureRest(sample, { id: 42 });
    const p = pendingResponse();
    h.shadow.finish(sample, 200, p.res);
    expect(h.shadow.inFlight()).toBe(1);
    p.emit('close');
    p.emit('finish');
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_status']);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.shadow.inFlight()).toBe(0);
  });

  it('a REST response already closed when the handler returns (a client abort mid-handler) is skipped_status and holds no slot', async () => {
    // A destroyed response emits neither `finish` nor `close` again, so waiting on them would hold
    // the in-flight slot for good.
    const h = harness();
    const sample = h.shadow.beginRest('v1-models-id', modelsRequest('/api/v1/models/42'))!;
    h.shadow.captureRest(sample, { id: 42 });
    const p = pendingResponse();
    h.shadow.finish(sample, 200, { ...p.res, destroyed: true });
    await h.flush();
    expect(h.outcomes).toEqual(['skipped_status']);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.shadow.inFlight()).toBe(0);
  });

  // Invariant guard (green before the fix too): a later slot-take would let the second sample in.
  it('a REST response waiting to be sent counts against the in-flight cap', async () => {
    const h = harness({ config: { maxInFlight: 1 } });
    const first = h.shadow.beginRest('v1-models-id', modelsRequest('/api/v1/models/1'))!;
    h.shadow.captureRest(first, { id: 1 });
    const p = pendingResponse();
    h.shadow.finish(first, 200, p.res);
    const second = h.shadow.beginRest('v1-models-id', modelsRequest('/api/v1/models/2'))!;
    h.shadow.captureRest(second, { id: 2 });
    h.shadow.finish(second, 200, pendingResponse().res);
    expect(h.outcomes).toEqual(['dropped_overload']);
    p.emit('finish');
    await h.flush();
    expect(h.outcomes).toEqual(['dropped_overload', 'sent']);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  // Invariant guard (green before the fix too): the tRPC path is unchanged.
  it('a tRPC sample is read when finish is called, even on a response not yet sent', async () => {
    const h = harness();
    const sample = h.shadow.begin(request())!;
    const data = { items: [] };
    h.shadow.run(sample, () => h.shadow.capture(data, superjson.serialize(data), false));
    const p = pendingResponse();
    h.shadow.finish(sample, 200, p.res);
    expect(h.queued).toHaveLength(1);
    await h.flush();
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body.responseHeaders).toEqual({ 'cache-control': 'private, no-store' });
  });

  it('a REST sample without readable headers carries neither field', async () => {
    const h = harness();
    const sample = h.shadow.beginRest('v1-models', modelsRequest('/api/v1/models'))!;
    h.shadow.captureRest(sample, { items: [], metadata: {} });
    h.shadow.finish(sample, 200);
    await h.flush();
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('responseHeaders');
    expect(body).not.toHaveProperty('responseHeaderSet');
  });
});

describe('createFeedGoShadow — POST /api/search/*', () => {
  const SEARCH_URL = 'http://feed-go.test:9090/internal/shadow/api/search';

  function searchHarness(enabled = true) {
    const outcomes: string[] = [];
    const queued: Array<() => void> = [];
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 202 })
    );
    const shadow = createFeedGoShadow({
      config: config({ siteSearchUrl: SEARCH_URL }),
      enabled: () => true,
      enabledSiteSearch: () => enabled,
      random: () => 0,
      fetch: fetchMock as unknown as typeof fetch,
      record: (o) => void outcomes.push(o),
      recordEncode: () => undefined,
      now: () => 0,
      schedule: (fn) => void queued.push(fn),
    });
    const flush = async () => {
      while (queued.length) queued.shift()!();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    return { shadow, outcomes, fetchMock, flush };
  }

  const searchRequest = (headers: Record<string, string> = {}) => ({
    method: 'POST',
    url: '/api/search/indexes/models_v9/search?x=1',
    headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t; _ga=1', ...headers },
    query: { path: ['indexes', 'models_v9', 'search'] },
    body: { q: 'cat', limit: 2 },
  });

  it('is off without its flag, and never mirrors a GET or a credentialed request', () => {
    expect(searchHarness(false).shadow.beginSiteSearch(searchRequest())).toBeUndefined();
    const h = searchHarness();
    expect(h.shadow.beginSiteSearch({ ...searchRequest(), method: 'GET' })).toBeUndefined();
    expect(
      h.shadow.beginSiteSearch(searchRequest({ authorization: 'Bearer key' }))
    ).toBeUndefined();
    expect(h.outcomes).toEqual(['skipped_credential']);
  });

  // The sample carries the body as JSON, the path without the query, the session cookie only; the
  // backend's answer and the call spliced in as JSON, and Node's answer as `node.body`.
  it('posts the body, the call, the backend answer and the answer Node wrote', async () => {
    const h = searchHarness();
    const sample = h.shadow.beginSiteSearch(searchRequest())!;
    expect(sample.endpoint).toBe('site-search');
    const backend = Buffer.from('{"hits":[{"id":1,"name":"R","sfwName":"S"}]}');
    h.shadow.captureSiteSearch(sample, {
      path: '/indexes/models_v9/search',
      request: '{"q":"cat","limit":2,"filter":["poi != true"]}',
      response: backend,
      body: { hits: [{ id: 1, name: 'S' }] },
    });
    h.shadow.finish(sample, 200, { getHeaders: () => ({ 'cache-control': 'private, no-store' }) });
    await h.flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(SEARCH_URL);
    expect(JSON.parse(init.body as string)).toEqual({
      input: '{"q":"cat","limit":2}',
      path: '/api/search/indexes/models_v9/search',
      headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t' },
      upstream: { hits: [{ id: 1, name: 'R', sfwName: 'S' }] },
      node: {
        upstream: {
          path: '/indexes/models_v9/search',
          body: { q: 'cat', limit: 2, filter: ['poi != true'] },
        },
        body: { hits: [{ id: 1, name: 'S' }] },
      },
      responseHeaders: { 'cache-control': 'private, no-store' },
      responseHeaderSet: 'rest',
      sampleRate: 1,
    });
    expect(h.outcomes).toEqual(['sent']);
  });

  it("a passthrough answer is mirrored as Node's bytes", async () => {
    const h = searchHarness();
    const sample = h.shadow.beginSiteSearch(searchRequest())!;
    const raw = Buffer.from('{"hits":[],"query":"cat"}');
    h.shadow.captureSiteSearch(sample, { path: '/p', request: '{}', response: raw, raw });
    h.shadow.finish(sample, 200);
    await h.flush();
    const body = JSON.parse(h.fetchMock.mock.calls[0][1].body as string);
    expect(body.node.body).toEqual({ hits: [], query: 'cat' });
  });

  it('a non-200 or an uncaptured answer is not sent', async () => {
    const h = searchHarness();
    h.shadow.finish(h.shadow.beginSiteSearch(searchRequest())!, 400);
    h.shadow.finish(h.shadow.beginSiteSearch(searchRequest())!, 200);
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped_status', 'skipped_no_capture']);
  });
});
