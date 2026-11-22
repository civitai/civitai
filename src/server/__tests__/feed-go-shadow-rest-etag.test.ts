import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiResponse } from 'next';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';
import { generateETag } from 'next/dist/server/lib/etag';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The response headers a REST feed-go shadow sample carries, on the path a deployed
 * `/api/v1/models/[id]` request takes: Next's own API resolver (whose `res.json` sets the ETag, its
 * `generateETag` over the body string), the REAL `PublicEndpoint` wrapper and the REAL `withAxiom`
 * inside it, over a real socket. The route below is shaped like the model routes: begin, capture
 * the body, `res.status(200).json(body)`, and `finishFeedGoShadow` in `finally`.
 *
 * `withAxiom` replaces `res.json` with one that flushes the request's logs and only then calls
 * Next's, so in the route's `finally` the ETag is not set yet. Every other test of these routes
 * stubs `withAxiom` to a pass-through (and the golden header cases add the ETag themselves), which is
 * how a sample without the ETag went unseen: feed-go then reported it missing on every compare.
 * Here the sampled ETag must equal the one the client received.
 *
 * Only the heavy module-load imports of endpoint-helpers are stubbed (as in
 * src/server/utils/__tests__/public-endpoint-credentialed-cache.test.ts), never `withAxiom`.
 */

vi.mock('~/env/server', () => ({
  env: new Proxy(
    { TRPC_ORIGINS: [] as string[], NEXTAUTH_URL: undefined } as Record<string, unknown>,
    { get: (t, p: string) => (p in t ? t[p] : undefined) }
  ),
}));
vi.mock('~/server/db/db-helpers', () => ({ checkNotUpToDate: vi.fn() }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/utils/key-generator', () => ({ generateSecretHash: vi.fn() }));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: vi.fn(() => []) }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ isClientAbortError: vi.fn(() => false) }));

import '~/__tests__/mocks/db.mock';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { createFeedGoShadow, type FeedGoShadowSample } from '~/server/trpc/feed-go-shadow';

const COMPARE_URL = 'http://feed-go.test:9090/internal/shadow/api/v1/models/id';

// The body this route answers: a fixed object, so its ETag is a fixed string.
const BODY = { id: 42, name: 'Model 42', modelVersions: [{ id: 7, name: 'v1' }] };

const outcomes: string[] = [];
const posted: Array<{ url: string; body: any }> = [];
const shadow = createFeedGoShadow({
  config: {
    url: undefined,
    v1ImagesUrl: undefined,
    infiniteUrl: undefined,
    modelGetAllUrl: undefined,
    modelAssociatedUrl: undefined,
    v1ModelsUrl: undefined,
    v1ModelsIdUrl: COMPARE_URL,
    rate: 1,
    timeoutMs: 500,
    maxInFlight: 4,
    maxPerSecond: 1000,
    probeUrl: undefined,
    probeInfiniteUrl: undefined,
    probeModelGetAllUrl: undefined,
    probeRate: 0,
  },
  enabled: () => false,
  enabledV1Models: () => true,
  random: () => 0,
  fetch: (async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(init.body as string) });
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch,
  record: (o) => void outcomes.push(o),
  recordEncode: () => undefined,
  now: () => 0,
});

const route = PublicEndpoint(async function handler(req, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  const sample: FeedGoShadowSample | undefined = shadow.beginRest('v1-models-id', req);
  try {
    if (sample) shadow.captureRest(sample, BODY);
    return res.status(200).json(BODY);
  } finally {
    if (sample) shadow.finish(sample, res.statusCode, res);
  }
});

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void apiResolver(req, res, { id: '42' }, { default: route }, {} as never, false);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Wait (bounded) until the sample reached an outcome: the send runs on a later turn. */
async function settled(count: number) {
  await vi.waitFor(() => expect(outcomes.length).toBeGreaterThanOrEqual(count), {
    timeout: 5_000,
    interval: 10,
  });
}

describe('feed-go shadow, /api/v1/models/[id] shape: the sampled ETag is the one sent', () => {
  it('a sampled 200 carries the ETag Next set on the response', async () => {
    outcomes.length = 0;
    posted.length = 0;
    const res = await fetch(`${base}/api/v1/models/42`);
    const text = await res.text();
    expect(res.status).toBe(200);
    const sentEtag = res.headers.get('etag');
    // Positive control: Next did send an ETag, and it is its own hash of the body string.
    expect(sentEtag).toBe(generateETag(JSON.stringify(BODY)));
    expect(text).toBe(JSON.stringify(BODY));

    await settled(1);
    expect(outcomes).toEqual(['sent']);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(COMPARE_URL);
    expect(posted[0].body.responseHeaderSet).toBe('rest');
    expect(posted[0].body.responseHeaders.etag).toBe(sentEtag);
    expect(posted[0].body.responseHeaders['cache-control']).toBe(res.headers.get('cache-control'));
    expect(posted[0].body.node).toEqual(BODY);
  });

  it('a 304 Next answers to a matching If-None-Match is not sampled as a 200', async () => {
    outcomes.length = 0;
    posted.length = 0;
    const etag = generateETag(JSON.stringify(BODY));
    const res = await fetch(`${base}/api/v1/models/42`, { headers: { 'if-none-match': etag } });
    await res.text();
    expect(res.status).toBe(304);

    await settled(1);
    expect(outcomes).toEqual(['skipped_status']);
    expect(posted).toHaveLength(0);
  });
});
