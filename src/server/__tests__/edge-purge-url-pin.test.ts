import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTRPCClient, httpLink } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The edge cache keys on the request URL byte for byte, and a purge can only refresh what was
 * recorded. So the URL recorded for a tagged query must be exactly the one the site's client
 * fetches. Driven end to end: the production link chain and serializer on the client, the real
 * route and `edgeCacheIt` on the server, and the real input schemas of the tagged procedures.
 */

vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

const roots = vi.hoisted(() => [] as { edgeTTL: number }[]);
vi.mock('~/server/createContext', () => ({
  createContext: ({ req, res }: { req: NextApiRequest; res: NextApiResponse }) => {
    // What createContext gives a signed-out caller.
    const cache = {
      edgeTTL: 7,
      browserTTL: 7,
      staleWhileRevalidate: 0,
      canCache: true,
      skip: false,
    };
    roots.push(cache);
    return {
      req,
      res,
      user: undefined,
      acceptableOrigin: true,
      features: { canViewNsfw: false },
      tokenScope: TokenScope.Full,
      cache,
    };
  },
}));

// One procedure per input shape the tagged procedures have, with their real schemas:
// none (generation/training status, model file options, feed tag bar), `getUserByUsernameSchema`
// (user.getCreator) and `eventSchema` (event.getDonors).
vi.mock('~/server/routers', async () => {
  const { router, publicProcedure } = await import('~/server/trpc');
  const { edgeCacheIt } = await import('~/server/middleware.trpc');
  const { getUserByUsernameSchema } = await import('~/server/schema/user.schema');
  const { eventSchema } = await import('~/server/schema/event.schema');
  const tagged = (tag: string) => edgeCacheIt({ ttl: 60, tags: () => [tag] });
  return {
    appRouter: router({
      noInput: publicProcedure.use(tagged('pin-none')).query(() => ({ ok: true })),
      creator: publicProcedure
        .input(getUserByUsernameSchema)
        .use(tagged('pin-creator'))
        .query(() => ({ ok: true })),
      donors: publicProcedure
        .input(eventSchema)
        .use(tagged('pin-donors'))
        .query(() => ({ ok: true })),
    }),
  };
});

const { REDIS_KEYS } = await import('~/server/redis/client');
const { authedCacheBypassLink } = await import('~/utils/trpc');
const { clientTransformer } = await import('~/shared/utils/trpc-union-transformer');

const lua = createLuaRedis(Date.now());
redisMock.redis.eval.mockImplementation(
  (script: string, opts: { keys: string[]; arguments: string[] }) => lua.eval(script, opts)
);

const requested: string[] = [];
let server: http.Server | undefined;
let baseUrl = '';

beforeAll(async () => {
  const route = (await import('~/pages/api/trpc/[trpc]')).default as NextApiHandler;
  server = http.createServer((req, res) => {
    requested.push(req.url ?? '');
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

type Client = Record<string, { query: (input?: unknown) => Promise<unknown> }>;
const client = () =>
  createTRPCClient<AnyTRPCRouter>({
    links: [
      authedCacheBypassLink as never,
      httpLink({ url: `${baseUrl}/api/trpc`, transformer: clientTransformer }),
    ],
  }) as unknown as Client;

describe('the URL a purge refreshes is the URL the client fetched', () => {
  it.each([
    ['noInput', 'pin-none', undefined],
    ['creator', 'pin-creator', { id: 42 }],
    ['creator', 'pin-creator', { username: 'someone' }],
    ['donors', 'pin-donors', { event: 'holiday2026' }],
  ])('%s %j', async (path, tag, input) => {
    lua.setSet(`${REDIS_KEYS.CACHES.EDGE_CACHED}:${tag}`, []);
    requested.length = 0;
    roots.length = 0;

    await client()[path].query(input);

    expect(requested).toHaveLength(1);
    expect(roots[0].edgeTTL).toBe(60);
    expect(lua.set(`${REDIS_KEYS.CACHES.EDGE_CACHED}:${tag}`)).toEqual([requested[0]]);
  });

  it.each([
    ['noInput', 'pin-none', undefined],
    ['creator', 'pin-creator', { id: 42 }],
  ])('%s %j, signed in', async (path, tag, input) => {
    lua.setSet(`${REDIS_KEYS.CACHES.EDGE_CACHED}:${tag}`, []);
    requested.length = 0;
    roots.length = 0;
    vi.stubGlobal('window', { isAuthed: true });
    try {
      await client()[path].query(input);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requested[0]).toContain(encodeURIComponent('"authed":true'));
    expect(roots[0].edgeTTL).toBe(60);
    expect(lua.set(`${REDIS_KEYS.CACHES.EDGE_CACHED}:${tag}`)).toEqual([requested[0]]);
  });
});
