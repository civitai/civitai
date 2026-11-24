import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadNextConfigHeaders } from '~/__tests__/next-config-headers';
import { runMiddlewares } from '~/server/middleware/index';

/**
 * The Go feed service (apps/feed-go) can answer a request from a blocked region itself
 * (FEED_GO_ANSWER_REGION_BLOCKED) instead of handing it to this app. Its answer must be this app's,
 * byte for byte, on every route it answers. apps/feed-go/testdata/golden/region-blocked/responses.json
 * holds what this app answers on each of those routes; feed-go's region_blocked_test.go asserts its
 * own answer equals the file, and this test asserts the file equals the app's REAL answer:
 *
 *   - the tRPC routes: the real `/api/trpc/[trpc]` route over a socket, with no proxy in front (the
 *     proxy never runs on `/api/trpc`). `applyApiRequestPolicy` answers before tRPC runs, so the 451
 *     is an HTTP-level answer, not a tRPC error envelope, and a batch gets the same one;
 *   - the REST routes: the real proxy middleware chain (`runMiddlewares`), which answers before the
 *     route runs;
 *   - on both, the next.config.mjs headers the router sets before either, read through Next's own
 *     pipeline in a production build (loadNextConfigHeaders).
 *
 * Headers are every response header but the transport ones, so a header the app starts sending on
 * this answer fails here rather than being silently missing from feed-go's.
 */

const GOLDEN = join(process.cwd(), 'apps/feed-go/testdata/golden/region-blocked/responses.json');
const TRANSPORT = new Set([
  'date',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);
const BLOCKED_BODY = {
  error: 'Access to this service is not available in your region due to legal restrictions.',
  code: 'REGION_BLOCKED',
};

type GoldenRoute = {
  endpoint: string;
  path: string;
  requestHeaders: Record<string, string>;
  status: number;
  headers: Record<string, string>;
  body: string;
};
type Answer = { status: number; headers: Record<string, string>; body: string };

const golden = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { routes: GoldenRoute[] }).routes;

const prod = await loadNextConfigHeaders('production');
vi.unstubAllEnvs();

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
// Never reached on a blocked region (the policy answers first); mocked so the route loads without
// the app's context and routers, as in trpc-route-api-policy.test.ts.
vi.mock('~/server/createContext', () => ({
  createContext: () => {
    throw new Error('createContext ran for a blocked region');
  },
}));
vi.mock('~/server/routers', async () => {
  const { router, publicProcedure } = await import('~/server/trpc');
  return { appRouter: router({ ping: publicProcedure.query(() => 'pong') }) };
});

/** The router's config headers for `url`, then the route's own (a later setHeader replaces). */
function withConfigHeaders(url: string, own: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of prod.matchedHeaders(url)) out[key.toLowerCase()] = value;
  for (const [key, value] of own) {
    const k = key.toLowerCase();
    if (TRANSPORT.has(k) || k.startsWith('x-middleware-')) continue;
    out[k] = value;
  }
  return out;
}

let server: http.Server | undefined;
let baseUrl = '';

beforeAll(async () => {
  const route = (await import('~/pages/api/trpc/[trpc]')).default as NextApiHandler;
  server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      (req as unknown as NextApiRequest).query = {
        ...Object.fromEntries(url.searchParams),
        trpc: decodeURIComponent(url.pathname.replace('/api/trpc/', '')),
      };
      await route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    })().catch((err) => {
      res.statusCode = 599;
      res.end(String(err));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
});

async function viaTrpcRoute(path: string, headers: Record<string, string>): Promise<Answer> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return {
    status: res.status,
    headers: withConfigHeaders(path, res.headers.entries()),
    body: await res.text(),
  };
}

async function viaProxy(path: string, headers: Record<string, string>): Promise<Answer> {
  const res = await runMiddlewares(new NextRequest(`https://civitai.com${path}`, { headers }));
  return {
    status: res.status,
    headers: withConfigHeaders(path, res.headers.entries()),
    body: await res.text(),
  };
}

const answer = (g: GoldenRoute) =>
  g.path.startsWith('/api/trpc/')
    ? viaTrpcRoute(g.path, g.requestHeaders)
    : viaProxy(g.path, g.requestHeaders);

describe('feed-go region-blocked golden: the app answer on every route feed-go answers', () => {
  it('covers each public feed-go route once', () => {
    expect(golden.map((g) => g.endpoint).sort()).toEqual(
      ['as-posts', 'infinite', 'model-getall', 'v1-images', 'v1-models', 'v1-models-id'].sort()
    );
  });

  it.each(golden.map((g) => [g.endpoint, g] as const))(
    '%s: the golden is the real answer',
    async (_e, g) => {
      expect(await answer(g)).toEqual({ status: g.status, headers: g.headers, body: g.body });
    }
  );

  // Pinned as literals, so the comparison above is not two copies of the same unknown.
  it('POSITIVE CONTROL: every route answers the 451 with the JSON body, and nothing else', async () => {
    for (const g of golden) {
      const a = await answer(g);
      expect(a.status).toBe(451);
      expect(JSON.parse(a.body)).toEqual(BLOCKED_BODY);
      expect(a.headers).toEqual({ 'content-type': 'application/json', 'x-frame-options': 'DENY' });
    }
  });

  it('CONTROL: an allowed region is not answered 451 on either path', async () => {
    const us = { 'cf-ipcountry': 'US' };
    expect((await viaTrpcRoute('/api/trpc/ping', us)).status).not.toBe(451);
    const rest = await runMiddlewares(
      new NextRequest('https://civitai.com/api/v1/models?limit=2', { headers: us })
    );
    expect(rest.headers.get('x-middleware-next')).toBe('1'); // passed through to the route
  });

  it('a tRPC batch gets the same HTTP-level 451, not a per-call tRPC error', async () => {
    const single = golden.find((g) => g.endpoint === 'as-posts')!;
    const batch = await viaTrpcRoute(
      '/api/trpc/image.getImagesAsPostsInfinite,model.getAll?batch=1&input=%7B%7D',
      single.requestHeaders
    );
    expect(batch).toEqual({ status: single.status, headers: single.headers, body: single.body });
  });
});
