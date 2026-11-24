import { createRequire } from 'node:module';
import type { NextApiRequest, NextApiResponse } from 'next';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiCacheMiddleware } from '~/server/middleware/api-cache.middleware';
import { apiRegionBlockMiddleware } from '~/server/middleware/api-region-block.middleware';
import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';
import { botDetectionMiddleware } from '~/server/middleware/bot-detection.middleware';
import { middlewares, runMiddlewares } from '~/server/middleware/index';
import {
  registerStandaloneApiPolicy,
  STANDALONE_API_POLICY_KEY,
} from '~/server/middleware/standalone-api-policy';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { CF_VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/edge-verified-bot';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';

/**
 * Under its `api` profile the standalone server (`scripts/trpc-server/server.cjs`) serves `/api/v1/`
 * routes WITHOUT the proxy, and stands in for it by calling `applyApiRequestPolicy` before the
 * route. That is only correct while the proxy MIDDLEWARES' whole effect on an `/api/v1/` request IS
 * that function. (Next's request-body cap around the proxy is separate: the server reproduces it
 * with `applyProxyBodyLimit`, tested in `scripts/trpc-server/__tests__/next-compat.test.ts` and by
 * the parity case `v1-body-over-proxy-cap`.) This file pins the seam from both sides:
 *
 *   1. which proxy middlewares run on an `/api/v1/` request: exactly the three the policy
 *      reproduces. A new middleware that acts on `/api/v1/` fails here, which is the point: the
 *      standalone server would not run it.
 *   2. behaviour: for each request below, the proxy chain (`runMiddlewares`, the real list) and the
 *      policy produce the same outcome — status when they answer, default response headers, and the
 *      verified-crawler request header the route will see.
 *   3. the hand-off: instrumentation's registration puts the function under the global key the
 *      CommonJS server reads (`served-pages.cjs`), so the two spellings cannot drift.
 */

const require = createRequire(import.meta.url);
const served = require('../../../../scripts/trpc-server/served-pages.cjs') as {
  API_POLICY_GLOBAL_KEY: string;
  needsApiPolicy: (page: string) => boolean;
};

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
// GOOGLEBOT_IP is in a googlebot-ips.json range; OTHER_IP is in no crawler range.
const GOOGLEBOT_IP = '192.178.4.1';
const OTHER_IP = '203.0.113.9';
const POD = 'test-pod-v1';
const EDGE_SECRET = 'standalone-edge-secret';

beforeAll(() => {
  vi.stubEnv('PODNAME', POD);
  setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: EDGE_SECRET });
});
afterAll(() => {
  vi.unstubAllEnvs();
});

type Outcome = {
  status: number | null; // the status when it answered, null when the route runs
  body: string | null;
  cacheControl: string | null;
  handledBy: string | null;
  bot: string | null; // the verified-crawler request header the route sees
};

/** The proxy chain's outcome, read the way Next applies a middleware response. */
async function viaProxy(path: string, headers: Record<string, string>): Promise<Outcome> {
  const res = await runMiddlewares(new NextRequest(`https://civitai.com${path}`, { headers }));
  const passthrough = res.headers.get('x-middleware-next') === '1';
  const override = res.headers.get('x-middleware-override-headers');
  let bot: string | null = headers[VERIFIED_BOT_HEADER] ?? null;
  if (override !== null) {
    const names = override.split(',').map((n) => n.trim());
    bot = names.includes(VERIFIED_BOT_HEADER)
      ? res.headers.get(`x-middleware-request-${VERIFIED_BOT_HEADER}`)
      : null;
  }
  return {
    status: passthrough ? null : res.status,
    body: passthrough ? null : await res.text(),
    cacheControl: res.headers.get('cache-control'),
    handledBy: res.headers.get('x-handled-by'),
    bot,
  };
}

/** The policy's outcome on a plain Node request/response pair, as the standalone server calls it. */
function viaPolicy(path: string, headers: Record<string, string>): Outcome {
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) reqHeaders[k.toLowerCase()] = v;
  const req = { url: path, method: 'GET', headers: reqHeaders } as unknown as NextApiRequest;
  const resHeaders = new Map<string, string>();
  let body: string | null = null;
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      resHeaders.set(name.toLowerCase(), String(value));
    },
    end(chunk?: string) {
      body = chunk ?? '';
    },
  } as unknown as NextApiResponse;
  const answered = applyApiRequestPolicy(req, res);
  return {
    status: answered ? res.statusCode : null,
    body: answered ? body : null,
    cacheControl: resHeaders.get('cache-control') ?? null,
    handledBy: resHeaders.get('x-handled-by') ?? null,
    bot: (req.headers[VERIFIED_BOT_HEADER] as string | undefined) ?? null,
  };
}

const CASES: [string, string, Record<string, string>][] = [
  ['plain request', '/api/v1/models/1', { 'user-agent': BROWSER, 'cf-connecting-ip': OTHER_IP }],
  [
    'verified crawler',
    '/api/v1/images?limit=1',
    {
      'user-agent': GOOGLEBOT,
      'cf-connecting-ip': GOOGLEBOT_IP,
      [CF_VERIFIED_BOT_HEADER]: EDGE_SECRET,
    },
  ],
  [
    'crawler UA from a non-crawler IP',
    '/api/v1/models',
    { 'user-agent': GOOGLEBOT, 'cf-connecting-ip': OTHER_IP },
  ],
  [
    'client-sent verified-bot header',
    '/api/v1/models',
    { 'user-agent': BROWSER, 'cf-connecting-ip': OTHER_IP, [VERIFIED_BOT_HEADER]: 'googlebot' },
  ],
  [
    'blocked region',
    '/api/v1/models/1',
    { 'user-agent': BROWSER, 'cf-connecting-ip': OTHER_IP, 'cf-ipcountry': 'GB' },
  ],
  ['no client IP headers', '/api/v1/enums', { 'user-agent': GOOGLEBOT }],
];

describe('the proxy on an /api/v1/ request', () => {
  it.each(CASES)('runs exactly the three policy middlewares (%s)', (_name, path, headers) => {
    const request = new NextRequest(`https://civitai.com${path}`, { headers });
    const running = middlewares.filter((m) => !m.shouldRun || m.shouldRun(request));
    expect(running).toEqual([apiRegionBlockMiddleware, apiCacheMiddleware, botDetectionMiddleware]);
  });

  it.each(CASES)(
    'has the same outcome as applyApiRequestPolicy (%s)',
    async (_n, path, headers) => {
      const proxy = await viaProxy(path, headers);
      const policy = viaPolicy(path, headers);
      expect(policy).toEqual(proxy);
    }
  );

  // Positive controls: the comparison above can see each effect, so equality is not two nulls.
  it('sees a 451, the default headers and a set crawler header', async () => {
    const at = (i: number) => [CASES[i][1], CASES[i][2]] as const;
    expect((await viaProxy(...at(4))).status).toBe(451);
    expect(viaPolicy(...at(4)).status).toBe(451);
    const plain = viaPolicy(...at(0));
    expect(plain.cacheControl).toBe('max-age=0, private, no-cache');
    expect(plain.handledBy).toBe(POD);
    expect(viaPolicy(...at(1)).bot).toBe('googlebot');
    expect((await viaProxy(...at(1))).bot).toBe('googlebot');
    expect(viaPolicy(...at(3)).bot).toBeNull();
  });
});

describe('the standalone server applies it to exactly the /api/v1/ pages', () => {
  it.each([
    ['/api/v1/models', true],
    ['/api/v1/models/[id]', true],
    ['/api/v1/blocks/storage/[[...path]]', true],
    ['/api/auth/session', false],
    ['/api/auth/oauth/[...path]', false],
    ['/api/trpc/[trpc]', false],
    ['/api/internal/ping', false],
    ['/api/v1x/models', false],
  ])('%s -> %s', (page, expected) => {
    expect(served.needsApiPolicy(page)).toBe(expected);
  });
});

describe('registerStandaloneApiPolicy', () => {
  it('puts applyApiRequestPolicy under the key the CommonJS server reads', () => {
    expect(STANDALONE_API_POLICY_KEY).toBe(served.API_POLICY_GLOBAL_KEY);
    const key = Symbol.for(served.API_POLICY_GLOBAL_KEY);
    const g = globalThis as Record<symbol, unknown>;
    const before = g[key];
    try {
      delete g[key];
      registerStandaloneApiPolicy();
      expect(g[key]).toBe(applyApiRequestPolicy);
    } finally {
      if (before === undefined) delete g[key];
      else g[key] = before;
    }
  });
});
