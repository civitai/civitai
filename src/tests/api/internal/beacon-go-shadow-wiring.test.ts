import { EventEmitter } from 'node:events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The beacon handlers' wiring to the beacon-go shadow sampler, end to end through the real
 * /api/internal/ping and /api/internal/pulse handlers with the sampler switched on and fetch
 * injected: the sample posted after the response must carry the tracker row. That needs the handler
 * to attach the sampler to its Tracker (the row arrives through `Tracker.onSend`) and, on pulse, whose
 * view is not awaited, to hold the send until the view settles (`waitFor`).
 *
 * The Tracker is a stand-in that delivers its row through `onSend` the way `Tracker.send` does, but
 * only after a delay, so a handler that does not wait would post a sample with no row.
 */

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { BEACON_GO_SHADOW: 'beacon-go-shadow' },
}));
// The `beacon-go-shadow` flag, on.
vi.mock('~/server/utils/otel-withspan-gate', () => ({
  createCachedFlagGate: (read: () => boolean) => read,
  readFliptSwitch: () => () => true,
}));
vi.mock('~/server/prom/beacon-go-shadow.metrics', () => ({
  BEACON_GO_SHADOW_ENDPOINTS: ['ping', 'pulse'],
  recordBeaconGoShadowOutcome: vi.fn(),
}));

const ROW_DELAY_MS = 20;

vi.mock('~/server/clickhouse/client', () => ({
  trackerSends: () => true,
  Tracker: class {
    onSend?: (table: string, row: object) => void;
    async pageView(values: { pageId: string }) {
      await new Promise((r) => setTimeout(r, ROW_DELAY_MS));
      this.onSend?.('pageViews', { pageId: values.pageId });
      return true;
    }
    async view(values: { type: string }) {
      await new Promise((r) => setTimeout(r, ROW_DELAY_MS));
      this.onSend?.('views', { type: values.type });
      return true;
    }
  },
}));

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  send(body: string) {
    return this.end(body);
  }
  body: unknown;
  end(chunk?: unknown) {
    this.body = chunk;
    // Node emits 'finish' once the response is flushed, after the handler's synchronous work.
    setImmediate(() => this.emit('finish'));
    return this;
  }
}

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
  async () => new Response(null, { status: 202 })
);

async function sentSample() {
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
  const [url, init] = fetchMock.mock.calls[0];
  return { url, sample: JSON.parse(init.body as string) };
}

describe('beacon handlers → beacon-go shadow sampler', () => {
  beforeEach(async () => {
    vi.stubEnv('BEACON_GO_SHADOW_URL', 'http://beacon-go.test:9090');
    vi.stubEnv('BEACON_GO_SHADOW_SAMPLE_RATE', '1');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    (await import('~/server/beacon/beacon-go-shadow')).resetBeaconGoShadowForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ping: the sample carries the pageViews row', async () => {
    const handler = (await import('~/pages/api/internal/ping')).default;
    const req = {
      method: 'POST',
      url: '/api/internal/ping',
      headers: { host: 'www.example.test', referer: 'https://www.example.test/images' },
      body: JSON.stringify({ path: '/images' }),
    } as unknown as NextApiRequest;
    const res = new FakeRes();
    await handler(req, res as unknown as NextApiResponse);
    const { url, sample } = await sentSample();
    expect(url).toBe('http://beacon-go.test:9090/internal/shadow/api/internal/ping');
    expect(sample.node.status).toBe(200);
    expect(sample.node.writes).toEqual([{ table: 'pageViews', body: '{"pageId":"/images"}' }]);
  });

  it('pulse: the sample waits for the un-awaited view and carries the views row', async () => {
    const handler = (await import('~/pages/api/internal/pulse')).default;
    const req = {
      method: 'POST',
      url: '/api/internal/pulse',
      headers: { host: 'www.example.test', origin: 'https://www.example.test' },
      body: { type: 'ImageView', entityType: 'Image', entityId: 1 },
    } as unknown as NextApiRequest;
    const res = new FakeRes();
    await handler(req, res as unknown as NextApiResponse);
    const { url, sample } = await sentSample();
    expect(url).toBe('http://beacon-go.test:9090/internal/shadow/api/internal/pulse');
    expect(sample.node.status).toBe(200);
    expect(sample.node.writes).toEqual([{ table: 'views', body: '{"type":"ImageView"}' }]);
  });
});
