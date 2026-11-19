import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `Retry-After` reaches HTTP clients from the route's `responseMeta`. Driven over a real socket
 * through the real route and adapter, as `trpc-client-config-headers.test.ts` is, so the test
 * sees the header the client sees, not what `retryAfterHeader` returns.
 */

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
vi.mock('~/server/routers', async () => {
  const { router, publicProcedure } = await import('~/server/trpc');
  const { throwRateLimited } = await import('~/server/utils/rate-limit-error');
  return {
    appRouter: router({
      limited: publicProcedure.query(() =>
        throwRateLimited(
          { retryAfterSeconds: 900, retryAt: new Date(Date.now() + 900_000).toISOString() },
          'Slow down.'
        )
      ),
      bare: publicProcedure.query(() => {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'No.' });
      }),
      ok: publicProcedure.query(() => ({ ok: true })),
    }),
  };
});

let server: http.Server | undefined;
let baseUrl = '';

beforeAll(async () => {
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

async function call(path: string) {
  const res = await fetch(`${baseUrl}/api/trpc/${path}`);
  return Object.assign(res, { body_: await res.text() });
}

const batchInput = `batch=1&input=${encodeURIComponent('{}')}`;

describe('Retry-After on a rate-limited tRPC response', () => {
  it('is set to retryAfterSeconds on a single refused call', async () => {
    const res = await call('limited');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('900');
  });

  it('is set on a batch of one refused call', async () => {
    const res = await call(`limited?${batchInput}`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('900');
  });

  it('is absent on a batch of two, where calls share one set of headers', async () => {
    const res = await call(`limited,ok?${batchInput}`);
    expect(res.status).toBe(207);
    expect(res.body_).toContain('TOO_MANY_REQUESTS');
    expect(res.body_).toContain('"ok":true');
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('is absent on a 429 with no retry metadata', async () => {
    const res = await call('bare');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
  });
});
