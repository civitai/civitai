import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  SITE_ALERTS_VERSION_FIELD,
  SITE_ALERTS_VERSION_HEADER,
} from '~/shared/constants/site-alert.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The site alerts version reaches browsers as a response header set in
 * the route's `responseMeta`, from the CLIENT hash read that `needsUpdate` already makes. Driven
 * over a real socket through the real route and adapter, as `trpc-response-write-format.test.ts`
 * is, because the streamed batch path writes its head before any procedure finishes.
 */

const VERSION = '1761170000000';
const FORCED_CLIENT_VERSION = '5.0.100';

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/createContext', () => ({
  createContext: ({ req, res }: { req: NextApiRequest; res: NextApiResponse }) => ({
    req,
    res,
    user: undefined,
    acceptableOrigin: true,
    features: { canViewNsfw: false },
    tokenScope: TokenScope.Full,
    cache:
      req.headers['x-test-cacheable'] === '1'
        ? { edgeTTL: 60, browserTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false }
        : { edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0, canCache: false, skip: false },
  }),
}));
vi.mock('~/server/routers', async () => {
  const { router, publicProcedure } = await import('~/server/trpc');
  return { appRouter: router({ payload: publicProcedure.query(() => ({ ok: true })) }) };
});

let server: http.Server | undefined;
let baseUrl = '';

beforeAll(async () => {
  redisMock.sysRedis.hGetAll.mockImplementation(async () => ({
    version: FORCED_CLIENT_VERSION,
    [SITE_ALERTS_VERSION_FIELD]: VERSION,
  }));
  const route = (await import('~/pages/api/trpc/[trpc]')).default as NextApiHandler;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (req as unknown as NextApiRequest).query = {
      ...Object.fromEntries(url.searchParams),
      trpc: decodeURIComponent(url.pathname.replace('/api/trpc/', '')),
    };
    void route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
});

const WEB = { 'x-client': 'web', 'x-client-version': '5.0.200' };

async function get(path: string, headers: Record<string, string>) {
  return (await getWithBody(path, headers)).headers;
}

async function getWithBody(path: string, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}/api/trpc/${path}`, { headers });
  const text = await res.text();
  expect(res.status).toBe(200);
  return { headers: res.headers, text };
}

const streamedBatch = (headers: Record<string, string>) =>
  get(`payload,payload,payload?batch=1&input=${encodeURIComponent('{}')}`, {
    ...headers,
    'trpc-accept': 'application/jsonl',
  });

describe('x-alerts-version', () => {
  // One `it`, in order: the CLIENT read is cached per process, and the count is the claim.
  it('rides streamed and edge-cached responses with no Redis read of its own', async () => {
    // Cold process: the streamed head is written before needsUpdate has read anything.
    expect((await streamedBatch(WEB)).get(SITE_ALERTS_VERSION_HEADER)).toBeNull();
    redisMock.sysRedis.hGetAll.mockClear();

    expect((await streamedBatch(WEB)).get(SITE_ALERTS_VERSION_HEADER)).toBe(VERSION);
    const cached = await get('payload', { ...WEB, 'x-test-cacheable': '1' });
    expect(cached.get(SITE_ALERTS_VERSION_HEADER)).toBe(VERSION);
    expect(cached.get('cache-control')).toMatch(/s-maxage=60/);

    // Four web procedures inside the CLIENT cache TTL, each answered with the header: no reads.
    expect(redisMock.sysRedis.hGetAll).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hGet).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });

  it('is not sent to a non-web client', async () => {
    // A web request first, so the CLIENT value is cached and only the client check can stop it.
    expect((await get('payload', WEB)).get(SITE_ALERTS_VERSION_HEADER)).toBe(VERSION);
    expect((await get('payload', {})).get(SITE_ALERTS_VERSION_HEADER)).toBeNull();
  });
});
