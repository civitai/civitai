/**
 * The Go-first probe of the feed-go shadow sampler (`probe` in `~/server/trpc/feed-go-shadow`):
 * which sampled requests are probed, what is posted, the bounds it shares with the shadow
 * comparison, and that every failure is swallowed into an outcome. Driven through
 * `createFeedGoShadow` with injected flags / random / fetch / clocks. That the route starts the
 * probe BEFORE the handler computes is pinned end to end in
 * `src/server/__tests__/trpc-feed-go-shadow.test.ts`.
 */
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { createFeedGoShadow, type FeedGoShadowConfig } from '~/server/trpc/feed-go-shadow';

const SHADOW_URL = 'http://feed-go.test:9090/internal/shadow/image.getImagesAsPostsInfinite';
const PROBE_URL = 'http://feed-go.test:9090/internal/probe/image.getImagesAsPostsInfinite';
const PROBE_INF_URL = 'http://feed-go.test:9090/internal/probe/image.getInfinite';
const PROBE_MODELS_URL = 'http://feed-go.test:9090/internal/probe/model.getAll';
const INPUT = '{"json":{"modelVersionId":9,"limit":20}}';
const STARTED_AT = 1_763_200_000_123.25;

function config(overrides: Partial<FeedGoShadowConfig> = {}): FeedGoShadowConfig {
  return {
    url: SHADOW_URL,
    v1ImagesUrl: 'http://feed-go.test:9090/internal/shadow/api/v1/images',
    infiniteUrl: 'http://feed-go.test:9090/internal/shadow/image.getInfinite',
    modelGetAllUrl: 'http://feed-go.test:9090/internal/shadow/model.getAll',
    modelAssociatedUrl:
      'http://feed-go.test:9090/internal/shadow/model.getAssociatedResourcesCardData',
    imagePublishedAppUrl: 'http://feed-go.test:9090/internal/shadow/image.getPublishedWithApp',
    v1ModelsUrl: 'http://feed-go.test:9090/internal/shadow/api/v1/models',
    v1ModelsIdUrl: 'http://feed-go.test:9090/internal/shadow/api/v1/models/id',
    rate: 1,
    timeoutMs: 500,
    maxInFlight: 4,
    maxPerSecond: 1000,
    probeUrl: PROBE_URL,
    probeInfiniteUrl: PROBE_INF_URL,
    probeModelGetAllUrl: PROBE_MODELS_URL,
    probeRate: 1,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t; theme=dark' },
    query: { trpc: 'image.getImagesAsPostsInfinite', input: INPUT },
    ...overrides,
  } as {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    query: Partial<Record<string, string | string[]>>;
  };
}

function harness(
  opts: {
    config?: Partial<FeedGoShadowConfig>;
    shadow?: boolean;
    probe?: boolean;
    random?: () => number;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  } = {}
) {
  const probeOutcomes: string[] = [];
  const shadowOutcomes: string[] = [];
  const queued: Array<() => void> = [];
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    opts.fetchImpl ?? (async () => new Response(null, { status: 202 }))
  );
  const shadow = createFeedGoShadow({
    config: config(opts.config),
    enabled: () => opts.shadow ?? true,
    enabledV1Images: () => true,
    enabledInfinite: () => true,
    enabledModelGetAll: () => true,
    enabledModelAssociated: () => true,
    enabledImagePublishedApp: () => true,
    enabledProbe: () => opts.probe ?? true,
    random: opts.random ?? (() => 0),
    fetch: fetchMock as unknown as typeof fetch,
    record: (o) => void shadowOutcomes.push(o),
    recordEncode: () => undefined,
    recordProbe: (o) => void probeOutcomes.push(o),
    now: () => 0,
    epochNow: () => STARTED_AT,
    schedule: (fn) => void queued.push(fn),
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const flush = async () => {
    while (queued.length) queued.shift()!();
    await settle();
  };
  const probeCalls = () =>
    fetchMock.mock.calls.filter(([url]) =>
      [PROBE_URL, PROBE_INF_URL, PROBE_MODELS_URL].includes(url)
    );
  return { shadow, probeOutcomes, shadowOutcomes, fetchMock, probeCalls, flush, settle };
}

/** One request the way the route runs it: begin, probe, the handler, finish. */
function serve(h: ReturnType<typeof harness>, req = request(), onHandler?: () => void) {
  const sample = h.shadow.begin(req);
  h.shadow.probe(sample);
  const data = { items: [] };
  h.shadow.run(sample, () => {
    onHandler?.();
    h.shadow.capture(data, superjson.serialize(data), false);
  });
  if (sample) h.shadow.finish(sample, 200);
  return sample;
}

describe('the Go-first probe', () => {
  it('posts the input, the forwarded headers and the start time, before the handler runs', async () => {
    const order: string[] = [];
    const h = harness({
      fetchImpl: async (url) => {
        order.push(url === PROBE_URL ? 'probe' : 'shadow');
        return new Response(null, { status: 202 });
      },
    });
    serve(h, request(), () => order.push('handler'));
    // The probe POST was started synchronously, ahead of the handler; the shadow send waits for
    // the scheduled turn after the response.
    expect(order).toEqual(['probe', 'handler']);
    await h.flush();
    expect(order).toEqual(['probe', 'handler', 'shadow']);

    const [[url, init]] = h.probeCalls();
    expect(url).toBe(PROBE_URL);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      input: INPUT,
      headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t' },
      startedAt: STARTED_AT,
    });
    expect(h.probeOutcomes).toEqual(['sent']);
    expect(h.shadowOutcomes).toEqual(['sent']);
    expect(h.shadow.inFlight()).toBe(0);
  });

  it.each([
    ['the shadow sampler off (flag)', { shadow: false }],
    ['the shadow sampler off (no URL)', { config: { url: undefined, probeUrl: undefined } }],
    ['the shadow sampler off (rate 0)', { config: { rate: 0 } }],
  ])('never probes with %s', async (_name, opts) => {
    const h = harness(opts as Parameters<typeof harness>[0]);
    expect(serve(h)).toBeUndefined();
    await h.flush();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.probeOutcomes).toEqual([]);
  });

  it.each([
    ['the probe flag off', { probe: false }],
    ['probe rate 0', { config: { probeRate: 0 } }],
    ['no probe URL', { config: { probeUrl: undefined } }],
  ])('%s: the shadow comparison still runs, the probe does not', async (_name, opts) => {
    const h = harness(opts as Parameters<typeof harness>[0]);
    expect(serve(h)).toBeDefined();
    await h.flush();
    expect(h.probeCalls()).toHaveLength(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.shadowOutcomes).toEqual(['sent']);
    expect(h.probeOutcomes).toEqual([]);
  });

  it('probes its own fraction of the sampled requests', async () => {
    // The shadow decision reads random() first (0: sampled), the probe second.
    const draws = [0, 0.49, 0, 0.5];
    const h = harness({ config: { rate: 1, probeRate: 0.5 }, random: () => draws.shift()! });
    serve(h);
    serve(h);
    await h.flush();
    expect(h.probeCalls()).toHaveLength(1);
    expect(h.shadowOutcomes).toEqual(['sent', 'sent']);
  });

  it('is bounded by the shared in-flight cap, holding its own slot until the POST settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      config: { maxInFlight: 2 },
      fetchImpl: async () => {
        await gate;
        return new Response(null, { status: 202 });
      },
    });
    const sample = h.shadow.begin(request());
    h.shadow.probe(sample);
    expect(h.shadow.inFlight()).toBe(2); // the sample's slot and the probe's
    // A second sampled request finds the cap reached: dropped before it is a sample at all.
    expect(h.shadow.begin(request())).toBeUndefined();
    expect(h.shadowOutcomes).toEqual(['dropped_overload']);
    release();
    await h.settle();
    expect(h.probeOutcomes).toEqual(['sent']);
    expect(h.shadow.inFlight()).toBe(1); // the sample still holds its own until finish
  });

  it('is dropped, not sent, when its sample took the last in-flight slot', async () => {
    const h = harness({ config: { maxInFlight: 1 } });
    serve(h);
    await h.flush();
    expect(h.probeCalls()).toHaveLength(0);
    expect(h.probeOutcomes).toEqual(['dropped_overload']);
    expect(h.shadowOutcomes).toEqual(['sent']);
  });

  it('probes an image.getInfinite sample at its own probe path', async () => {
    const h = harness();
    const sample = h.shadow.begin(request({ query: { trpc: 'image.getInfinite', input: INPUT } }));
    expect(sample?.endpoint).toBe('infinite');
    h.shadow.probe(sample);
    await h.settle();
    const calls = h.probeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(PROBE_INF_URL);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({
      input: INPUT,
      headers: { host: 'civitai.com', cookie: '__Secure-civ-token=t' },
      startedAt: STARTED_AT,
    });
    // No infinite probe URL: not probed.
    const off = harness({ config: { probeInfiniteUrl: undefined } });
    off.shadow.probe(
      off.shadow.begin(request({ query: { trpc: 'image.getInfinite', input: INPUT } }))
    );
    await off.settle();
    expect(off.probeCalls()).toHaveLength(0);
  });

  it('probes a model.getAll sample at its own probe path', async () => {
    const h = harness();
    const sample = h.shadow.begin(request({ query: { trpc: 'model.getAll', input: INPUT } }));
    expect(sample?.endpoint).toBe('model-getall');
    h.shadow.probe(sample);
    await h.settle();
    const calls = h.probeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(PROBE_MODELS_URL);
  });

  // feed-go has no probe for model.getAssociatedResourcesCardData: its sample is compared, never
  // probed (no request of any kind leaves at the start of the request).
  it('never probes a model.getAssociatedResourcesCardData sample', async () => {
    const h = harness();
    const sample = h.shadow.begin(
      request({ query: { trpc: 'model.getAssociatedResourcesCardData', input: INPUT } })
    );
    expect(sample?.endpoint).toBe('model-associated');
    h.shadow.probe(sample);
    await h.settle();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.probeOutcomes).toEqual([]);
  });

  // Nor for image.getPublishedWithApp: no probe exists for it in feed-go.
  it('never probes an image.getPublishedWithApp sample', async () => {
    const h = harness();
    const sample = h.shadow.begin(
      request({ query: { trpc: 'image.getPublishedWithApp', input: '{"json":{"id":7}}' } })
    );
    expect(sample?.endpoint).toBe('image-published-app');
    h.shadow.probe(sample);
    await h.settle();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.probeOutcomes).toEqual([]);
  });

  it('runs at most once per sample, and never for a REST sample', async () => {
    const h = harness();
    const sample = h.shadow.begin(request());
    h.shadow.probe(sample);
    h.shadow.probe(sample);
    const rest = h.shadow.beginV1Images(
      request({ url: '/api/v1/images?limit=1', query: { limit: '1' } })
    );
    expect(rest).toBeDefined();
    h.shadow.probe(rest);
    h.shadow.probe(undefined);
    await h.settle();
    expect(h.probeCalls()).toHaveLength(1);
  });

  it.each([
    ['rejected', async () => new Response(null, { status: 500 })],
    [
      'timeout',
      async () => {
        throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      },
    ],
    [
      'error',
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ],
  ] as const)('counts %s, and the request never sees it', async (want, impl) => {
    const h = harness({ fetchImpl: impl });
    expect(() => h.shadow.probe(h.shadow.begin(request()))).not.toThrow();
    await h.settle();
    expect(h.probeOutcomes).toEqual([want]);
    expect(h.shadow.inFlight()).toBe(1); // only the sample's own slot is left
  });

  it('a fetch that throws synchronously is an error, and frees the slot', () => {
    const h = harness({
      fetchImpl: () => {
        throw new Error('bad url');
      },
    });
    h.shadow.probe(h.shadow.begin(request()));
    expect(h.probeOutcomes).toEqual(['error']);
    expect(h.shadow.inFlight()).toBe(1);
  });
});
