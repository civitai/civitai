/**
 * The beacon-go shadow sampler (`~/server/beacon/beacon-go-shadow`): which requests are sampled (the
 * gates, in order), what is forwarded (and what is not), and that the send carries the tracker rows
 * and waits for an un-awaited view. Driven through `createBeaconGoShadow` with injected flag /
 * tracker / random / fetch / clock, so each case pins one decision.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { hostSessionCookieName, legacySessionCookieName, sessionCookieName } from '@civitai/auth';
import {
  beaconGoShadowUrl,
  createBeaconGoShadow,
  readBeaconGoShadowConfig,
  type BeaconGoShadowConfig,
} from '~/server/beacon/beacon-go-shadow';
import {
  pickBeaconSessionCookies,
  pickBeaconShadowHeaders,
  shadowBody,
  shadowTarget,
} from '~/server/beacon/beacon-go-shadow-payload';

const BASE = 'http://beacon-go.test:9090/';

function config(overrides: Partial<BeaconGoShadowConfig> = {}): BeaconGoShadowConfig {
  return {
    base: BASE,
    rate: 1,
    trackBatchRate: 0,
    timeoutMs: 500,
    maxInFlight: 4,
    maxPerSecond: 1000,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: '/api/internal/ping',
    headers: {
      host: 'www.example.test',
      referer: 'https://www.example.test/models/1',
      cookie: 'other=1; __Secure-civ-token=tok.en.sig; _ga=GA1',
      authorization: 'Bearer secret-key',
      'user-agent': 'UA/1.0',
      'x-unrelated': 'dropped',
    } as Record<string, string | string[] | undefined>,
    body: '{"path":"/models/1"}',
    ...overrides,
  };
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  ended: unknown[] = [];
  getHeader(name: string) {
    return this.headers[name];
  }
  end(...args: unknown[]) {
    this.ended = args;
    return this;
  }
}

function harness(
  opts: {
    config?: Partial<BeaconGoShadowConfig>;
    enabled?: boolean;
    trackerSends?: boolean;
    random?: number;
  } = {}
) {
  const record = vi.fn();
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 202 })
  );
  let clock = 0;
  const shadow = createBeaconGoShadow({
    config: config(opts.config),
    enabled: () => opts.enabled ?? true,
    trackerSends: () => opts.trackerSends ?? true,
    random: () => opts.random ?? 0,
    fetch: fetchMock as unknown as typeof fetch,
    record,
    now: () => clock,
  });
  return {
    shadow,
    record,
    fetchMock,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('beacon-go shadow gating', () => {
  it('is off without a URL, at rate 0, without a tracker, with the flag off, and outside the rate', () => {
    const cases: Parameters<typeof harness>[0][] = [
      { config: { base: undefined } },
      { config: { rate: 0 } },
      { trackerSends: false },
      { enabled: false },
      { config: { rate: 0.5 }, random: 0.5 },
    ];
    for (const c of cases) {
      const { shadow, record } = harness(c);
      expect(shadow.begin(request(), new FakeRes(), 'ping')).toBeUndefined();
      expect(shadow.inFlight()).toBe(0);
      expect(record).not.toHaveBeenCalled();
    }
  });

  // /api/track/batch has its own rate (BEACON_GO_SHADOW_TRACK_BATCH_SAMPLE_RATE, default 0), so the
  // ping / pulse shadow being on samples no batch, and the batch rate samples no beacon.
  it('samples track-batch at its own rate only', () => {
    const beaconsOnly = harness({ config: { rate: 1, trackBatchRate: 0 } });
    expect(beaconsOnly.shadow.begin(request(), new FakeRes(), 'track-batch')).toBeUndefined();
    expect(beaconsOnly.shadow.begin(request(), new FakeRes(), 'ping')).toBeDefined();
    expect(beaconsOnly.record).not.toHaveBeenCalled();

    const batchOnly = harness({ config: { rate: 0, trackBatchRate: 1 } });
    expect(batchOnly.shadow.begin(request(), new FakeRes(), 'ping')).toBeUndefined();
    expect(batchOnly.shadow.begin(request(), new FakeRes(), 'pulse')).toBeUndefined();
    expect(batchOnly.shadow.begin(request(), new FakeRes(), 'track-batch')).toBeDefined();

    const half = harness({ config: { rate: 1, trackBatchRate: 0.25 }, random: 0.25 });
    expect(half.shadow.begin(request(), new FakeRes(), 'track-batch')).toBeUndefined();
    const inside = harness({ config: { rate: 0, trackBatchRate: 0.25 }, random: 0.24 });
    expect(inside.shadow.begin(request(), new FakeRes(), 'track-batch')).toBeDefined();
    // The flag still gates it.
    const flagOff = harness({ config: { trackBatchRate: 1 }, enabled: false });
    expect(flagOff.shadow.begin(request(), new FakeRes(), 'track-batch')).toBeUndefined();
  });

  it('samples inside the rate', () => {
    const { shadow } = harness({ config: { rate: 0.5 }, random: 0.49 });
    expect(shadow.begin(request(), new FakeRes(), 'ping')).toBeDefined();
    expect(shadow.inFlight()).toBe(1);
  });

  it('checks the tracker before the flag (no flag read for a request that writes nothing)', () => {
    const enabled = vi.fn(() => true);
    const shadow = createBeaconGoShadow({
      config: config(),
      enabled,
      trackerSends: () => false,
      random: () => 0,
      fetch: vi.fn() as unknown as typeof fetch,
      record: vi.fn(),
    });
    expect(shadow.begin(request(), new FakeRes(), 'pulse')).toBeUndefined();
    expect(enabled).not.toHaveBeenCalled();
  });

  it('drops past the in-flight cap and past the per-second budget, per endpoint', () => {
    const over = harness({ config: { maxInFlight: 1 } });
    expect(over.shadow.begin(request(), new FakeRes(), 'ping')).toBeDefined();
    expect(over.shadow.begin(request(), new FakeRes(), 'pulse')).toBeUndefined();
    expect(over.record).toHaveBeenCalledWith('dropped_overload', 'pulse');

    const rate = harness({ config: { maxPerSecond: 1 } });
    expect(rate.shadow.begin(request(), new FakeRes(), 'ping')).toBeDefined();
    expect(rate.shadow.begin(request(), new FakeRes(), 'ping')).toBeUndefined();
    expect(rate.record).toHaveBeenCalledWith('dropped_rate_limit', 'ping');
    // The other endpoint has its own bucket; a second later the first has refilled.
    expect(rate.shadow.begin(request(), new FakeRes(), 'pulse')).toBeDefined();
    rate.tick(1000);
    expect(rate.shadow.begin(request(), new FakeRes(), 'ping')).toBeDefined();
  });

  it('releases a sample whose client went away before the response finished', () => {
    const { shadow, fetchMock } = harness();
    const res = new FakeRes();
    shadow.begin(request(), res, 'ping');
    res.emit('close');
    expect(shadow.inFlight()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('beacon-go shadow payload', () => {
  it('posts the request, the response and the rows after finish', async () => {
    const { shadow, fetchMock, record } = harness();
    const res = new FakeRes();
    const sample = shadow.begin(request(), res, 'ping')!;
    shadow.captureWrite(sample, 'pageViews', { userId: 0, path: '/models/1' });
    res.statusCode = 400;
    res.headers = {
      vary: 'Authorization, Cookie',
      etag: '"weftv9g98bf"',
      'set-cookie': 'civ=secret',
    };
    res.end('invalid request');
    expect(res.ended).toEqual(['invalid request']);
    res.emit('finish');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://beacon-go.test:9090/internal/shadow/api/internal/ping');
    expect(JSON.parse(init.body as string)).toEqual({
      method: 'POST',
      target: '/api/internal/ping',
      query: '',
      headers: {
        host: 'www.example.test',
        referer: 'https://www.example.test/models/1',
        'user-agent': 'UA/1.0',
        cookie: '__Secure-civ-token=tok.en.sig',
        authorization: 'present',
      },
      body: '{"path":"/models/1"}',
      bodyIsString: true,
      node: {
        status: 400,
        headers: {
          vary: 'Authorization, Cookie',
          etag: '"weftv9g98bf"',
          'set-cookie': '<redacted>',
        },
        body: 'invalid request',
        writes: [{ table: 'pageViews', body: '{"userId":0,"path":"/models/1"}' }],
      },
    });
    await flush();
    expect(record).toHaveBeenCalledWith('sent', 'ping');
    expect(shadow.inFlight()).toBe(0);
  });

  it('waits for an un-awaited view before sending', async () => {
    const { shadow, fetchMock } = harness();
    const res = new FakeRes();
    const sample = shadow.begin(request({ url: '/api/internal/pulse' }), res, 'pulse')!;
    let resolveView!: () => void;
    shadow.waitFor(sample, new Promise<void>((r) => (resolveView = r)));
    res.end();
    res.emit('finish');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    shadow.captureWrite(sample, 'views', { userId: 7 });
    resolveView();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.node.writes).toEqual([{ table: 'views', body: '{"userId":7}' }]);
    expect(sent.node.body).toBe('');
  });

  it('posts a track-batch sample to its own path, with every row in send order', async () => {
    const { shadow, fetchMock, record } = harness({ config: { trackBatchRate: 1 } });
    const res = new FakeRes();
    const body = [{ kind: 'search', data: { query: 'q', index: 'i' } }];
    const sample = shadow.begin(
      request({ url: '/api/track/batch', headers: { host: 'www.example.test' }, body }),
      res,
      'track-batch'
    )!;
    let resolveRows!: () => void;
    shadow.waitFor(sample, new Promise<void>((r) => (resolveRows = r)));
    res.end();
    res.emit('finish');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    shadow.captureWrite(sample, 'search', { userId: 0, query: 'q' });
    shadow.captureWrite(sample, 'actions', { userId: 0, type: 'AwardBounty_Click' });
    resolveRows();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://beacon-go.test:9090/internal/shadow/api/track/batch');
    expect(JSON.parse(init.body as string)).toEqual({
      method: 'POST',
      target: '/api/track/batch',
      query: '',
      headers: { host: 'www.example.test' },
      body: '[{"kind":"search","data":{"query":"q","index":"i"}}]',
      bodyIsString: false,
      node: {
        status: 200,
        headers: {},
        body: '',
        writes: [
          { table: 'search', body: '{"userId":0,"query":"q"}' },
          { table: 'actions', body: '{"userId":0,"type":"AwardBounty_Click"}' },
        ],
      },
    });
    await flush();
    expect(record).toHaveBeenCalledWith('sent', 'track-batch');
  });

  it('counts a non-2xx answer, a timeout and a network error', async () => {
    const answers: [() => Promise<Response>, string][] = [
      [() => Promise.resolve(new Response(null, { status: 503 })), 'rejected'],
      [() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'timeout'],
      [() => Promise.reject(new Error('ECONNREFUSED')), 'error'],
    ];
    for (const [answer, outcome] of answers) {
      const { shadow, fetchMock, record } = harness();
      fetchMock.mockImplementationOnce(answer);
      const res = new FakeRes();
      shadow.begin(request(), res, 'ping');
      res.end();
      res.emit('finish');
      await flush();
      await flush();
      expect(record).toHaveBeenCalledWith(outcome, 'ping');
      expect(shadow.inFlight()).toBe(0);
    }
  });
});

describe('beacon-go shadow pure helpers', () => {
  it('keeps only session cookies, split the way requestCarriesCallerCredentials splits', () => {
    expect(pickBeaconSessionCookies(undefined)).toBeUndefined();
    expect(pickBeaconSessionCookies('a=1; b=2')).toBeUndefined();
    expect(
      pickBeaconSessionCookies(
        'a=1; __Host-civ-token=x%2Ey;civ-token ; __Secure-civitai-token=; civitai-token=l; z=__Secure-civ-token'
      )
    ).toBe('__Host-civ-token=x%2Ey; civ-token; __Secure-civitai-token=; civitai-token=l');
  });

  // The seam with requestCarriesCallerCredentials: every name it treats as a credential (derived
  // there from the same helpers, SESSION_COOKIE_NAMES in endpoint-helpers.ts) is forwarded, so
  // beacon-go can decide Vary / Cache-Control the same way.
  it('forwards every cookie name the credential check reads', () => {
    const names = [
      hostSessionCookieName(true),
      sessionCookieName(true),
      sessionCookieName(false),
      legacySessionCookieName(true),
      legacySessionCookieName(false),
    ];
    expect(new Set(names).size).toBe(5);
    for (const name of names) {
      expect(pickBeaconSessionCookies(`other=1; ${name}=v`)).toBe(`${name}=v`);
    }
  });

  it('forwards an Authorization header only as present, and only when non-empty', () => {
    expect(pickBeaconShadowHeaders({ headers: { authorization: '' } })).toEqual({});
    expect(pickBeaconShadowHeaders({ headers: { authorization: 'Bearer k' } })).toEqual({
      authorization: 'present',
    });
    expect(
      pickBeaconShadowHeaders({
        headers: { 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'], 'cf-ipcountry': '' },
      })
    ).toEqual({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'cf-ipcountry': '' });
  });

  it('never forwards the query: only a marker for whether there is one, or a token', () => {
    expect(shadowTarget('/api/internal/ping')).toEqual({ target: '/api/internal/ping', query: '' });
    expect(shadowTarget('/api/internal/ping?')).toEqual({
      target: '/api/internal/ping',
      query: 'present',
    });
    expect(shadowTarget('/api/internal/ping?x=1&token=')).toEqual({
      target: '/api/internal/ping',
      query: 'present',
    });
    expect(shadowTarget('/api/internal/pulse?a=1&token=secret-api-key')).toEqual({
      target: '/api/internal/pulse',
      query: 'token',
    });
    expect(shadowTarget(undefined)).toEqual({ target: '', query: '' });
  });

  it('sends the path and the marker, never the key', async () => {
    const { shadow, fetchMock } = harness();
    const res = new FakeRes();
    shadow.begin(request({ url: '/api/internal/ping?token=secret-api-key' }), res, 'ping');
    res.end();
    res.emit('finish');
    await flush();
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).not.toContain('secret-api-key');
    expect(JSON.parse(body)).toMatchObject({ target: '/api/internal/ping', query: 'token' });
  });

  it('forwards the body as Next left it: a string as is, anything else as its JSON', () => {
    expect(shadowBody('{"a":1}')).toEqual({ body: '{"a":1}', bodyIsString: true });
    expect(shadowBody({ a: 1 })).toEqual({ body: '{"a":1}', bodyIsString: false });
    expect(shadowBody(undefined)).toEqual({ body: '', bodyIsString: false });
  });

  it('reads the env: off by default, clamped, http(s) only', () => {
    const off = readBeaconGoShadowConfig({});
    expect(off.base).toBeUndefined();
    expect(off.rate).toBe(0);
    expect(off.trackBatchRate).toBe(0);
    // The beacons' rate leaves track-batch off; its own rate is clamped the same way.
    expect(readBeaconGoShadowConfig({ BEACON_GO_SHADOW_SAMPLE_RATE: '1' }).trackBatchRate).toBe(0);
    expect(
      readBeaconGoShadowConfig({ BEACON_GO_SHADOW_TRACK_BATCH_SAMPLE_RATE: '0.05' }).trackBatchRate
    ).toBe(0.05);
    expect(
      readBeaconGoShadowConfig({ BEACON_GO_SHADOW_TRACK_BATCH_SAMPLE_RATE: '7' }).trackBatchRate
    ).toBe(1);
    const c = readBeaconGoShadowConfig({
      BEACON_GO_SHADOW_URL: 'http://beacon-go.test:9090',
      BEACON_GO_SHADOW_SAMPLE_RATE: '2',
      BEACON_GO_SHADOW_TIMEOUT_MS: '99999',
    });
    expect(c.base).toBe('http://beacon-go.test:9090/');
    expect(c.rate).toBe(1);
    expect(c.timeoutMs).toBe(10000);
    expect(readBeaconGoShadowConfig({ BEACON_GO_SHADOW_URL: 'ftp://x' }).base).toBeUndefined();
    expect(beaconGoShadowUrl('http://h:1/', 'pulse')).toBe(
      'http://h:1/internal/shadow/api/internal/pulse'
    );
    expect(beaconGoShadowUrl('http://h:1/', 'ping')).toBe(
      'http://h:1/internal/shadow/api/internal/ping'
    );
    expect(beaconGoShadowUrl('http://h:1/', 'track-batch')).toBe(
      'http://h:1/internal/shadow/api/track/batch'
    );
  });
});
