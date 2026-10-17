import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PRIVATE_CACHE_CONTROL } from '~/server/middleware/middleware-utils';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { createTrpcFastPath, isFastPathUrl } from '../trpc-server/fast-path.mjs';

/**
 * The fast path's own code — the part that is NOT Next's or the app's: how it hands a request to
 * the proxy chain and applies the result before the tRPC route runs. Driven over real HTTP with the
 * REAL proxy chain (`runMiddlewares`, called through Next's real `adapter`, the way the compiled
 * `.next/server/middleware.js` calls it) and a stub route that reports the request it was handed.
 *
 * What the route would do with that request is the route's own code and is not re-tested here; the
 * end-to-end comparison against Next's `server.js` is `scripts/trpc-server/parity-check.mjs`.
 */

const repoRoot = path.resolve(__dirname, '../..');
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
// In a googlebot-ips.json range / in no crawler range.
const GOOGLEBOT_IP = '192.178.4.1';
const OTHER_IP = '203.0.113.9';

type Seen = { headers: http.IncomingHttpHeaders; url?: string };

const nextConfig = {
  basePath: '',
  i18n: { locales: ['en'], defaultLocale: 'en' },
  trailingSlash: false,
  compress: false,
  experimental: {},
};

let adapter: (params: any) => Promise<any>;
let runMiddlewares: (request: NextRequest) => Promise<Response>;
beforeAll(async () => {
  // A Next server process installs its AsyncLocalStorage global before anything of Next's loads,
  // and Next's ALS-backed stores capture it at module load — so nothing Next-side is imported
  // statically above.
  await import('next/dist/server/node-environment-baseline');
  ({ adapter } = await import('next/dist/server/web/adapter'));
  ({ runMiddlewares } = await import('~/server/middleware'));
});

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise((r) => s.close(r));
    })
  );
});

async function start({
  proxy = (request: NextRequest) => runMiddlewares(request),
  route,
  configHeaders = [],
  redirects = [],
}: {
  proxy?: (request: NextRequest) => Promise<Response> | Response;
  route?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  configHeaders?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  redirects?: Array<Record<string, unknown>>;
} = {}) {
  const routeCalls: Seen[] = [];
  let fallbacks = 0;
  const entries = {
    // What the compiled middleware entry does (Next's `build/templates/middleware.js`): fill in the
    // page and the user's proxy function, then call the adapter.
    proxy: {
      default: (opts: any) => adapter({ ...opts, page: '/src/proxy', handler: proxy }),
    },
    proxyHandler: proxy,
    route: {
      handler: async (req: http.IncomingMessage, res: http.ServerResponse) => {
        routeCalls.push({ headers: { ...req.headers }, url: req.url });
        if (route) return route(req, res);
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      },
    },
  };
  // The fast path needs the port, which exists only once the server listens.
  const fast: { handle?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> } =
    {};
  const server = http.createServer((req, res) => {
    void fast.handle?.(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  fast.handle = createTrpcFastPath({
    dir: repoRoot,
    distDir: path.join(repoRoot, '.next'),
    hostname: '127.0.0.1',
    port,
    nextConfig,
    entries,
    routesManifest: {
      headers: configHeaders,
      redirects,
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    },
    nextHandler: async (_req, res) => {
      fallbacks++;
      res.statusCode = 299;
      res.end('next');
    },
  });
  const call = (p: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      redirect: 'manual',
      ...init,
      headers: { 'user-agent': BROWSER, 'cf-connecting-ip': OTHER_IP, ...headers },
    });
  return { call, routeCalls, fallbacks: () => fallbacks };
}

describe('isFastPathUrl', () => {
  it.each([
    '/api/trpc/model.getById',
    '/api/trpc/model.getById,image.getInfinite?batch=1&input=%7B%7D',
    '/api/trpc/buzz.getBuzzAccount?input=%7B%22json%22%3Anull%7D',
  ])('takes %s', (u) => expect(isFastPathUrl(u)).toBe(true));

  it.each([
    '/api/trpc/model.getById/',
    '/api/trpc/model.getById/extra',
    '/api/trpc/',
    '/api/trpc',
    '/api/trpc/model%2EgetById',
    '//api/trpc/model.getById',
    '/en/api/trpc/model.getById',
    '/api/v1/models',
    '/api/health',
    undefined,
  ])('leaves %s to Next', (u) => expect(isFastPathUrl(u)).toBe(false));
});

describe('the fast path applies the proxy chain as Next does', () => {
  it('strips a verified-bot header a browser sent', async () => {
    const s = await start();
    const res = await s.call('/api/trpc/image.get', { [VERIFIED_BOT_HEADER]: 'googlebot' });
    expect(res.status).toBe(200);
    expect(s.routeCalls).toHaveLength(1);
    expect(s.routeCalls[0].headers[VERIFIED_BOT_HEADER]).toBeUndefined();
    // the rest of the request survives the override's "delete what is not listed" step
    expect(s.routeCalls[0].headers['user-agent']).toBe(BROWSER);
  });

  it('sets it for a verified crawler (positive control for the strip)', async () => {
    const s = await start();
    await s.call('/api/trpc/image.get', {
      'user-agent': GOOGLEBOT,
      'cf-connecting-ip': GOOGLEBOT_IP,
    });
    expect(s.routeCalls[0].headers[VERIFIED_BOT_HEADER]).toBe('googlebot');
  });

  it('puts the default Cache-Control on the response, and lets the route override it', async () => {
    const s = await start();
    const plain = await s.call('/api/trpc/image.get');
    expect(plain.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);

    const s2 = await start({
      route: (_req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
        res.end('{}');
      },
    });
    const cached = await s2.call('/api/trpc/image.get');
    expect(cached.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
  });

  it("copies passthrough headers onto the request too, as Next's resolve-routes does", async () => {
    const s = await start();
    await s.call('/api/trpc/image.get', { 'cache-control': 'no-store' });
    expect(s.routeCalls[0].headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('answers an API-blocked region with the proxy’s 451 and never runs the route', async () => {
    const s = await start();
    const res = await s.call('/api/trpc/image.get', { 'cf-ipcountry': 'GB' });
    expect(res.status).toBe(451);
    expect(await res.json()).toMatchObject({ code: 'REGION_BLOCKED' });
    expect(s.routeCalls).toHaveLength(0);
  });

  // The shape next.config `headers()` takes in the routes manifest under i18n: Next matches it
  // against the default-locale-prefixed path, so it applies to API routes too.
  const everyPath = {
    source: '/:nextInternalLocale(en)/((?!gift-cards).*)',
    headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
  };

  it('adds the next.config headers Next adds to every path', async () => {
    const s = await start({ configHeaders: [everyPath] });
    const res = await s.call('/api/trpc/image.get');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    // ...and on a response the proxy ends, as the router server writes routing headers first
    const blocked = await s.call('/api/trpc/image.get', { 'cf-ipcountry': 'GB' });
    expect(blocked.status).toBe(451);
    expect(blocked.headers.get('x-frame-options')).toBe('DENY');
  });

  it('applies a next.config header only where its source matches', async () => {
    const s = await start({
      configHeaders: [
        {
          source: '/:nextInternalLocale(en)/gift-cards',
          headers: [{ key: 'X-Only-Gift', value: '1' }],
        },
      ],
    });
    const res = await s.call('/api/trpc/image.get');
    expect(res.headers.get('x-only-gift')).toBeNull();
  });

  it("adds Next's x-forwarded-* request headers, keeping any the client sent", async () => {
    const s = await start();
    await s.call('/api/trpc/image.get');
    expect(s.routeCalls[0].headers).toMatchObject({
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-proto': 'http',
      'x-forwarded-host': expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      'x-forwarded-port': expect.stringMatching(/^\d+$/),
    });
    await s.call('/api/trpc/image.get', {
      'x-forwarded-for': '198.51.100.7',
      'x-forwarded-proto': 'https',
    });
    expect(s.routeCalls[1].headers).toMatchObject({
      'x-forwarded-for': '198.51.100.7',
      'x-forwarded-proto': 'https',
    });
  });

  it('hands a request a next.config redirect applies to back to Next', async () => {
    const s = await start({
      redirects: [
        {
          source: '/:nextInternalLocale(en)/api/trpc/legacy.:rest',
          destination: '/x',
          permanent: true,
        },
        {
          source: '/api/trpc/:path',
          destination: '/y',
          permanent: false,
          has: [{ type: 'header', key: 'x-only-when' }],
        },
      ],
    });
    expect((await s.call('/api/trpc/legacy.thing')).status).toBe(299);
    expect(s.fallbacks()).toBe(1);
    // a conditional one applies only when its condition holds
    expect((await s.call('/api/trpc/image.get')).status).toBe(200);
    expect((await s.call('/api/trpc/image.get', { 'x-only-when': '1' })).status).toBe(299);
    expect(s.fallbacks()).toBe(2);
    expect(s.routeCalls).toHaveLength(1);
  });

  it('drops Next-internal headers a client sent', async () => {
    const s = await start();
    await s.call('/api/trpc/image.get', {
      'x-middleware-override-headers': 'x-civitai-verified-bot',
      'x-matched-path': '/api/admin',
    });
    expect(s.routeCalls[0].headers['x-middleware-override-headers']).toBeUndefined();
    expect(s.routeCalls[0].headers['x-matched-path']).toBeUndefined();
  });

  it('writes a proxy redirect relative to the request, as the router server does', async () => {
    const s = await start({
      proxy: (request) => Response.redirect(new URL('/region-blocked', request.url), 307),
    });
    const res = await s.call('/api/trpc/image.get');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/region-blocked');
    expect(await res.text()).toBe('/region-blocked');
    expect(s.routeCalls).toHaveLength(0);
  });

  it('hands a proxy rewrite to Next, untouched', async () => {
    const s = await start({
      proxy: () =>
        new Response(null, { headers: { 'x-middleware-rewrite': 'http://127.0.0.1/api/other' } }),
    });
    const res = await s.call('/api/trpc/image.get', { [VERIFIED_BOT_HEADER]: 'googlebot' });
    expect(res.status).toBe(299);
    expect(s.fallbacks()).toBe(1);
    expect(s.routeCalls).toHaveLength(0);
  });

  it('hands a request whose proxy throws to Next', async () => {
    const s = await start({
      proxy: () => {
        throw new Error('boom');
      },
    });
    const res = await s.call('/api/trpc/image.get');
    expect(res.status).toBe(299);
    expect(s.fallbacks()).toBe(1);
  });

  it('passes a POST body through to the route untouched', async () => {
    const s = await start({
      route: (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => res.end(body));
      },
    });
    const payload = JSON.stringify({ 0: { json: { id: 1 } } });
    const res = await s.call(
      '/api/trpc/model.getById?batch=1',
      { 'content-type': 'application/json' },
      { method: 'POST', body: payload }
    );
    expect(await res.text()).toBe(payload);
  });
});
