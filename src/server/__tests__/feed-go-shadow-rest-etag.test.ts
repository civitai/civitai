import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiResponse } from 'next';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';
import { generateETag } from 'next/dist/server/lib/etag';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { createFeedGoShadow, type FeedGoShadowSample } from '~/server/trpc/feed-go-shadow';

/**
 * The response headers a REST feed-go shadow sample carries, on the path a deployed
 * `/api/v1/models/[id]` request takes: Next's own API resolver (whose `res.json` sets the ETag, its
 * `generateETag` over the body string), the REAL `PublicEndpoint` wrapper and the REAL `withAxiom`
 * inside it, over a real socket. The route below is shaped like the model routes: begin, capture
 * the body, `res.status(200).json(body)`, and the sampler's `finish` in `finally`.
 *
 * `withAxiom` replaces `res.json` with one that flushes the request's logs and only then calls
 * Next's, so in the route's `finally` the ETag is not set yet. Every other test of these routes
 * stubs `withAxiom` to a pass-through (and the golden header cases add the ETag themselves), which is
 * how a sample without the ETag went unseen: feed-go then reported it missing on every compare.
 * Here the sampled ETag must equal the one the client received. Nothing here is mocked.
 */

const COMPARE_URL = 'http://feed-go.test:9090/internal/shadow/api/v1/models/id';

// The body this route answers: a fixed object, so its ETag is a fixed string.
const BODY = { id: 42, name: 'Model 42', modelVersions: [{ id: 7, name: 'v1' }] };

const outcomes: string[] = [];
const posted: Array<{ url: string; body: any }> = [];
/** Whether the ETag was already on the response when the route's `finally` ran, per request. */
const etagAtFinally: boolean[] = [];

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
    etagAtFinally.push(res.getHeader('etag') !== undefined);
    if (sample) shadow.finish(sample, res.statusCode, res);
  }
});

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    void apiResolver(req, res, { id: '42' }, { default: route }, {} as never, false);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * One GET over node:http, not fetch: fetch turns a request carrying `If-None-Match` into a
 * `Cache-Control: no-cache` one, which Next never answers with a 304.
 */
function get(headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>(
    (resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/v1/models/42', method: 'GET', headers },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    }
  );
}

function reset() {
  outcomes.length = 0;
  posted.length = 0;
  etagAtFinally.length = 0;
}

/** Wait (bounded) until the sample reached an outcome: the send runs on a later turn. */
async function settled() {
  await vi.waitFor(() => expect(outcomes.length).toBeGreaterThanOrEqual(1), {
    timeout: 5_000,
    interval: 10,
  });
}

describe('feed-go shadow, /api/v1/models/[id] shape: the sampled ETag is the one sent', () => {
  it('a sampled 200 carries the ETag Next set on the response', async () => {
    reset();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.text).toBe(JSON.stringify(BODY));
    const sentEtag = res.headers.etag;
    // Positive controls: Next did send an ETag, its own hash of the body string; and the real
    // withAxiom deferred it past the route's `finally` (a pass-through would have set it already,
    // and this case would then pass whatever `finish` does).
    expect(sentEtag).toBe(generateETag(JSON.stringify(BODY)));
    expect(etagAtFinally).toEqual([false]);

    await settled();
    expect(outcomes).toEqual(['sent']);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(COMPARE_URL);
    expect(posted[0].body.responseHeaderSet).toBe('rest');
    expect(posted[0].body.responseHeaders.etag).toBe(sentEtag);
    expect(posted[0].body.responseHeaders['cache-control']).toBe(res.headers['cache-control']);
    expect(posted[0].body.node).toEqual(BODY);
  });

  it('a 304 Next answers to a matching If-None-Match is not sampled as a 200', async () => {
    reset();
    const res = await get({ 'if-none-match': generateETag(JSON.stringify(BODY)) });
    expect(res.status).toBe(304);
    expect(etagAtFinally).toEqual([false]);

    await settled();
    expect(outcomes).toEqual(['skipped_status']);
    expect(posted).toHaveLength(0);
  });
});
