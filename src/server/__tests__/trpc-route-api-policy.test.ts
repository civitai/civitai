import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `/api/trpc` is not in the proxy matcher (`proxy-trpc-matcher.test.ts`), so Next never runs the
 * proxy middlewares on it: the route's own `applyApiRequestPolicy` call is the ONLY thing that gives
 * tRPC the region block (451), the default response headers and the verified-crawler header
 * decision. This runs the REAL route over a socket, with no proxy in front, and asserts each of
 * those effects, so removing or bypassing that call fails here by behaviour, not by spelling.
 */

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
// GOOGLEBOT_IP is in a googlebot-ips.json range; OTHER_IP is in no crawler range.
const GOOGLEBOT_IP = '192.178.4.1';
const OTHER_IP = '203.0.113.9';
const POD = 'test-pod-7';

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

beforeAll(async () => {
  vi.stubEnv('PODNAME', POD);
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
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server?.close(() => r()));
});

type Outcome = {
  status: number;
  body: string;
  cacheControl: string | null;
  handledBy: string | null;
};

async function call(headers: Record<string, string>): Promise<Outcome> {
  const res = await fetch(`${baseUrl}/api/trpc/seen`, { headers });
  return {
    status: res.status,
    body: await res.text(),
    cacheControl: res.headers.get('cache-control'),
    handledBy: res.headers.get('x-handled-by'),
  };
}

// Lives on the cross-graph registry `/api/metrics` merges into the scrape. Never registered reads 0.
const ROUTE_REGION_BLOCKS = 'civitai_app_trpc_route_region_blocks_total';
async function counterValue(name: string) {
  const metric = instrumentationRegistry.getSingleMetric(name);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.reduce((sum, v) => sum + v.value, 0);
}

type BotData = { bot: string | null };
// superjson (the default write format) wraps the payload in `json`.
function botSeen(o: Outcome) {
  expect(o.status).toBe(200);
  const data = (JSON.parse(o.body) as { result: { data: BotData | { json: BotData } } }).result
    .data;
  return 'json' in data ? data.json.bot : data.bot;
}

describe('/api/trpc applies the API policy with no proxy in front', () => {
  it('control: an allowed region reaches the procedure', async () => {
    const o = await call({ 'cf-ipcountry': 'US', 'user-agent': BROWSER });
    expect(botSeen(o)).toBeNull();
  });

  it('answers a blocked region with 451 before any procedure runs, and counts it', async () => {
    const before = await counterValue(ROUTE_REGION_BLOCKS);
    const o = await call({ 'cf-ipcountry': 'GB', 'user-agent': BROWSER });
    expect(o.status).toBe(451);
    expect(JSON.parse(o.body)).toEqual({
      error: 'Access to this service is not available in your region due to legal restrictions.',
      code: 'REGION_BLOCKED',
    });
    expect((await counterValue(ROUTE_REGION_BLOCKS)) - before).toBe(1);
  });

  it('sends the default Cache-Control and X-Handled-By', async () => {
    const o = await call({ 'cf-ipcountry': 'US', 'user-agent': BROWSER });
    expect(o.status).toBe(200);
    expect(o.cacheControl).toBe('max-age=0, private, no-cache');
    expect(o.handledBy).toBe(POD);
  });

  it('sets the verified-crawler header for a verified crawler', async () => {
    const o = await call({
      'cf-ipcountry': 'US',
      'user-agent': GOOGLEBOT,
      'cf-connecting-ip': GOOGLEBOT_IP,
    });
    expect(botSeen(o)).toBe('googlebot');
  });

  it('strips a spoofed verified-crawler header from a browser', async () => {
    const o = await call({
      'cf-ipcountry': 'US',
      'user-agent': BROWSER,
      'cf-connecting-ip': OTHER_IP,
      [VERIFIED_BOT_HEADER]: 'googlebot',
    });
    expect(botSeen(o)).toBeNull();
  });

  it('strips it for a crawler user agent from outside the crawler ranges', async () => {
    const o = await call({
      'cf-ipcountry': 'US',
      'user-agent': GOOGLEBOT,
      'cf-connecting-ip': OTHER_IP,
      [VERIFIED_BOT_HEADER]: 'googlebot',
    });
    expect(botSeen(o)).toBeNull();
  });
});
