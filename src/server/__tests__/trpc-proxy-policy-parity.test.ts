import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `/api/trpc` must behave the same whether the proxy middlewares run on it (flag
 * `trpc-skip-proxy-middleware` OFF, today) or the proxy hands it straight through and the route
 * applies the policy itself (flag ON). Each case runs the REAL proxy and the REAL route over a
 * socket, with the proxy's result applied the way Next applies it, and asserts the same outcome
 * under both flag states. It also records whether the proxy itself answered, so the flag-ON half
 * provably exercised the route-side path rather than the proxy again.
 */

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
// GOOGLEBOT_IP is in a googlebot-ips.json range; OTHER_IP is in no crawler range.
const GOOGLEBOT_IP = '192.178.4.1';
const OTHER_IP = '203.0.113.9';
const POD = 'test-pod-7';

let flagOn = false;
vi.mock('~/server/flipt/global-sync', () => ({
  isGlobalFliptFlagOn: (flag: string) => flag === 'trpc-skip-proxy-middleware' && flagOn,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/createContext', () => ({
  createContext: ({ req, res }: { req: NextApiRequest; res: NextApiResponse }) => ({
    req,
    res,
    user: undefined,
    acceptableOrigin: true,
    features: { canViewNsfw: false },
    tokenScope: TokenScope.Full,
    cache: { edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0, canCache: false, skip: false },
  }),
}));
// The one procedure reports the verified-crawler header exactly as the app's readers see it.
vi.mock('~/server/routers', async () => {
  const { router, publicProcedure } = await import('~/server/trpc');
  return {
    appRouter: router({
      seen: publicProcedure.query(({ ctx }) => ({
        bot: (ctx.req?.headers[VERIFIED_BOT_HEADER] as string | undefined) ?? null,
      })),
    }),
  };
});

let server: http.Server | undefined;
let baseUrl = '';
let proxyAnswered = false;

/**
 * What Next does with a proxy result: a non-passthrough response is sent as is and the route never
 * runs; a passthrough copies its response headers onto the route's response and, when it carries
 * request overrides, replaces the request headers with exactly the overridden set.
 */
async function applyProxyLikeNext(req: http.IncomingMessage, res: http.ServerResponse) {
  const { proxy } = await import('~/proxy');
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const result = await proxy(new NextRequest(`http://localhost${req.url}`, { headers }));

  if (result.headers.get('x-middleware-next') !== '1') {
    proxyAnswered = true;
    res.statusCode = result.status;
    result.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(await result.text());
    return false;
  }

  result.headers.forEach((v, k) => {
    if (!k.startsWith('x-middleware-')) res.setHeader(k, v);
  });
  const overrides = result.headers.get('x-middleware-override-headers');
  if (overrides !== null) {
    const keep = new Set(overrides.split(','));
    for (const k of Object.keys(req.headers)) if (!keep.has(k)) delete req.headers[k];
    for (const k of keep) {
      const v = result.headers.get(`x-middleware-request-${k}`);
      if (v !== null) req.headers[k] = v;
    }
  }
  return true;
}

beforeAll(async () => {
  vi.stubEnv('PODNAME', POD);
  const route = (await import('~/pages/api/trpc/[trpc]')).default as NextApiHandler;
  server = http.createServer((req, res) => {
    void (async () => {
      if (!(await applyProxyLikeNext(req, res))) return;
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
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server?.close(() => r()));
});

beforeEach(() => {
  proxyAnswered = false;
});

type Outcome = {
  status: number;
  body: string;
  cacheControl: string | null;
  handledBy: string | null;
  proxyAnswered: boolean;
};

async function call(headers: Record<string, string>, on: boolean): Promise<Outcome> {
  flagOn = on;
  proxyAnswered = false;
  const res = await fetch(`${baseUrl}/api/trpc/seen`, { headers });
  return {
    status: res.status,
    body: await res.text(),
    cacheControl: res.headers.get('cache-control'),
    handledBy: res.headers.get('x-handled-by'),
    proxyAnswered,
  };
}

type BotData = { bot: string | null };
// superjson (the default write format) wraps the payload in `json`.
function botSeen(o: Outcome) {
  expect(o.status).toBe(200);
  const data = (JSON.parse(o.body) as { result: { data: BotData | { json: BotData } } }).result
    .data;
  return 'json' in data ? data.json.bot : data.bot;
}

describe.each([
  ['OFF', false],
  ['ON', true],
])('tRPC with trpc-skip-proxy-middleware %s', (_, on) => {
  it('answers a blocked region with 451 before any procedure runs', async () => {
    const o = await call({ 'cf-ipcountry': 'GB', 'user-agent': BROWSER }, on);
    expect(o.status).toBe(451);
    expect(JSON.parse(o.body)).toEqual({
      error: 'Access to this service is not available in your region due to legal restrictions.',
      code: 'REGION_BLOCKED',
    });
    // OFF: the proxy answers. ON: the proxy passes it through and the route answers.
    expect(o.proxyAnswered).toBe(!on);
  });

  it('sends the default Cache-Control and X-Handled-By', async () => {
    const o = await call({ 'cf-ipcountry': 'US', 'user-agent': BROWSER }, on);
    expect(o.status).toBe(200);
    expect(o.cacheControl).toBe('max-age=0, private, no-cache');
    expect(o.handledBy).toBe(POD);
  });

  it('sets the verified-crawler header for a verified crawler', async () => {
    const o = await call(
      { 'cf-ipcountry': 'US', 'user-agent': GOOGLEBOT, 'cf-connecting-ip': GOOGLEBOT_IP },
      on
    );
    expect(botSeen(o)).toBe('googlebot');
  });

  it('strips a spoofed verified-crawler header', async () => {
    const o = await call(
      {
        'cf-ipcountry': 'US',
        'user-agent': BROWSER,
        'cf-connecting-ip': OTHER_IP,
        [VERIFIED_BOT_HEADER]: 'googlebot',
      },
      on
    );
    expect(botSeen(o)).toBeNull();
  });

  it('strips it for a crawler user agent from outside the crawler ranges', async () => {
    const o = await call(
      {
        'cf-ipcountry': 'US',
        'user-agent': GOOGLEBOT,
        'cf-connecting-ip': OTHER_IP,
        [VERIFIED_BOT_HEADER]: 'googlebot',
      },
      on
    );
    expect(botSeen(o)).toBeNull();
  });
});
