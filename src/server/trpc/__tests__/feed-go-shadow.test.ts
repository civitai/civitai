/**
 * The feed-go shadow sampler (`~/server/trpc/feed-go-shadow`): which requests are sampled, what
 * is forwarded (and what is not), the in-flight bound, and that every failure is swallowed into
 * an outcome instead of reaching the request.
 *
 * Driven through `createFeedGoShadow` with injected flag / random / fetch / schedule, so each case
 * pins one decision. The end-to-end path through the real route and transformer is
 * `src/server/__tests__/trpc-feed-go-shadow.test.ts`.
 */
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeedGoShadow,
  FEED_GO_SHADOW_PATH,
  pickSessionCookies,
  pickShadowHeaders,
  readFeedGoShadowConfig,
  SHADOW_DEFAULT_MAX_IN_FLIGHT,
  SHADOW_DEFAULT_TIMEOUT_MS,
  type FeedGoShadowConfig,
} from '~/server/trpc/feed-go-shadow';

const URL_ = 'http://feed-go.test:9090/internal/shadow/image.getImagesAsPostsInfinite';
const INPUT = '{"json":{"modelId":7,"limit":50},"meta":{"values":{"cursor":["undefined"]}}}';

function config(overrides: Partial<FeedGoShadowConfig> = {}): FeedGoShadowConfig {
  return { url: URL_, rate: 1, timeoutMs: 500, maxInFlight: 4, ...overrides };
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
    random?: number;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  } = {}
) {
  const outcomes: string[] = [];
  const queued: Array<() => void> = [];
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    opts.fetchImpl ?? (async () => new Response(null, { status: 202 }))
  );
  const shadow = createFeedGoShadow({
    config: config(opts.config),
    enabled: () => opts.enabled ?? true,
    random: () => opts.random ?? 0,
    fetch: fetchMock as unknown as typeof fetch,
    record: (o) => void outcomes.push(o),
    schedule: (fn) => void queued.push(fn),
  });
  const flush = async () => {
    while (queued.length) queued.shift()!();
    // Let the fetch promise chain settle.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { shadow, outcomes, fetchMock, flush, queued };
}

/** Run one request through begin → handler (serializing `written`) → finish. */
function serve(
  h: ReturnType<typeof harness>,
  req = request(),
  { status = 200, data = { items: [] }, written = superjson.serialize(data), devalue = false } = {}
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
      rate: 0,
      timeoutMs: SHADOW_DEFAULT_TIMEOUT_MS,
      maxInFlight: SHADOW_DEFAULT_MAX_IN_FLIGHT,
    });
  });

  it('appends the compare path to the base URL', () => {
    const c = readFeedGoShadowConfig({
      FEED_GO_SHADOW_URL: 'http://feed-go.feed-go.svc.cluster.local:9090',
      FEED_GO_SHADOW_SAMPLE_RATE: '0.25',
      FEED_GO_SHADOW_TIMEOUT_MS: '750',
      FEED_GO_SHADOW_MAX_IN_FLIGHT: '3',
    });
    expect(c).toEqual({
      url: `http://feed-go.feed-go.svc.cluster.local:9090${FEED_GO_SHADOW_PATH}`,
      rate: 0.25,
      timeoutMs: 750,
      maxInFlight: 3,
    });
  });

  it('rejects a non-http URL and clamps out-of-range numbers', () => {
    const c = readFeedGoShadowConfig({
      FEED_GO_SHADOW_URL: 'redis://x:1',
      FEED_GO_SHADOW_SAMPLE_RATE: '7',
      FEED_GO_SHADOW_TIMEOUT_MS: '999999',
      FEED_GO_SHADOW_MAX_IN_FLIGHT: '-2',
    });
    expect(c.url).toBeUndefined();
    expect(c.rate).toBe(1);
    expect(c.timeoutMs).toBe(10_000);
    expect(c.maxInFlight).toBe(1);
    expect(readFeedGoShadowConfig({ FEED_GO_SHADOW_URL: 'not a url' }).url).toBeUndefined();
    expect(readFeedGoShadowConfig({ FEED_GO_SHADOW_SAMPLE_RATE: 'abc' }).rate).toBe(0);
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
    ['another procedure', {}, request({ query: { trpc: 'image.getInfinite', input: INPUT } })],
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
  ])('does not sample: %s', async (_name, opts, req) => {
    const h = harness(opts as Parameters<typeof harness>[0]);
    expect(serve(h, req)).toBeUndefined();
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([]);
  });

  it('samples a fraction: random below the rate is sampled, at the rate is not', () => {
    expect(harness({ config: { rate: 0.3 }, random: 0.29 }).shadow.begin(request())).toBeDefined();
    expect(harness({ config: { rate: 0.3 }, random: 0.3 }).shadow.begin(request())).toBeUndefined();
  });

  it('reads the flag only after the cheap request checks', () => {
    const enabled = vi.fn(() => true);
    const shadow = createFeedGoShadow({ config: config(), enabled, record: () => undefined });
    shadow.begin(request({ query: { trpc: 'image.getInfinite' } }));
    expect(enabled).not.toHaveBeenCalled();
    shadow.begin(request());
    expect(enabled).toHaveBeenCalledTimes(1);
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
