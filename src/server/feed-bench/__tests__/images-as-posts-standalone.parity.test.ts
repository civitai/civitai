import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parse as parseQueryString } from 'node:querystring';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageController from '~/server/controllers/image.controller';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * The feed benchmark's standalone arm (`serveImagesAsPostsStandalone`) answers exactly what the
 * tRPC route answers, for the same request: same status, same body bytes, same Cache-Control.
 *
 * Both arms run for real: the tRPC route (`src/pages/api/trpc/[trpc].ts`, invoked through Next's own
 * `apiResolver`, which is what sets `req.query` and `req.cookies` in production) over the REAL image
 * router (`heavyProcedure`, its middlewares, its input schema), and the standalone function. Both
 * build their context with the REAL `createContext`. Replaced, identically for both:
 *   - the session read (signed in when the request carries a `bench-session=<userId>` cookie),
 *   - the feature flags (`canViewNsfw` off on a `green.` host, so the domain cap differs by host),
 *   - `getImagesAsPostsInfiniteHandler`, by a fake that ECHOES what it was called with (the parsed,
 *     clamped input and the viewer) inside a payload with a Date, an undefined and a Set, so the
 *     transformer's meta is exercised. The handler itself is the same function in both arms by
 *     construction (one import); what this test pins is everything around it.
 *
 * Inputs: every request in feed-go's golden fixtures (apps/feed-go/testdata/golden/as-posts), with
 * its host and its signed-in viewer, plus a request with no input and an invalid one.
 *
 * Mutants this catches (each was reasoned against the code, see the PR):
 *   - the domain clamp (`applyDomainFeature`) dropped or reordered after the schema: the echoed
 *     `browsingLevel` differs (the literal-level cases below);
 *   - `req.cookies` not set: the signed-in fixtures resolve signed out (viewer and clamp differ);
 *   - the cache headers not set: Cache-Control differs (signed out carries the edge TTLs);
 *   - a different body envelope or serializer (no `result.data`, JSON instead of superjson): bytes;
 *   - the page module losing the function the standalone server loads: the loader case.
 */

const PROCEDURE = 'image.getImagesAsPostsInfinite';
const SESSION_COOKIE = 'bench-session';

const calls = vi.hoisted(() => ({
  handler: [] as Array<{ input: Record<string, unknown>; viewer: number | null }>,
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: async ({ req }: { req: NextApiRequest }) => {
    const id = Number(req.cookies?.['bench-session']);
    return id ? { user: { id, username: `viewer${id}` } } : null;
  },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsLazy: ({ req }: { req?: NextApiRequest }) => ({
    canViewNsfw: !String(req?.headers?.host ?? '').startsWith('green.'),
    imageIndexFeed: true,
    galleryLazyPostImages: true,
  }),
}));
vi.mock('~/server/controllers/image.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageController>()),
  getImagesAsPostsInfiniteHandler: async ({
    input,
    ctx,
  }: {
    input: Record<string, unknown>;
    ctx: { user?: { id: number }; cache?: { edgeTTL?: number } };
  }) => {
    const viewer = ctx.user?.id ?? null;
    calls.handler.push({ input: structuredClone(input), viewer });
    return {
      nextCursor: input.cursor === undefined ? undefined : `${String(input.cursor)}+`,
      items: [
        {
          postId: 1,
          pinned: false,
          viewer,
          edgeTTL: ctx.cache?.edgeTTL ?? null,
          input,
          createdAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
          review: undefined,
          tagIds: new Set([3, 1]),
        },
      ],
    };
  },
}));
vi.mock('~/server/routers', async () => {
  const { router } = await import('~/server/trpc');
  const { imageRouter } = await import('~/server/routers/image.router');
  return { appRouter: router({ image: imageRouter }) };
});

type Req = { input?: string; host: string; userId?: number };
type Res = {
  status: number;
  body: string;
  cacheControl: string | null;
  contentType: string | null;
};

let trpcServer: http.Server;
let standaloneServer: http.Server;
let trpcBase = '';
let standaloneBase = '';

const listen = async (server: http.Server) => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  const route = await import('~/pages/api/trpc/[trpc]');
  const { serveImagesAsPostsStandalone } = await import(
    '~/server/feed-bench/images-as-posts-standalone'
  );
  trpcServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = {
      ...parseQueryString(url.search.slice(1)),
      trpc: decodeURIComponent(url.pathname.replace('/api/trpc/', '')),
    };
    void apiResolver(req, res, query, route, {} as never, false);
  });
  standaloneServer = http.createServer((req, res) => void serveImagesAsPostsStandalone(req, res));
  trpcBase = await listen(trpcServer);
  standaloneBase = await listen(standaloneServer);
}, 120_000);

afterAll(async () => {
  await Promise.all([trpcServer, standaloneServer].map((s) => new Promise((r) => s?.close(r))));
});

beforeEach(() => {
  calls.handler.length = 0;
});

async function get(base: string, r: Req): Promise<Res> {
  const qs = r.input === undefined ? '' : `?input=${encodeURIComponent(r.input)}`;
  const headers: Record<string, string> = { host: r.host };
  if (r.userId) headers.cookie = `theme=dark; ${SESSION_COOKIE}=${r.userId}`;
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(`${base}/api/trpc/${PROCEDURE}${qs}`, { headers }, resolve);
    req.on('error', reject);
    req.end();
  });
  let body = '';
  for await (const chunk of res) body += chunk;
  return {
    status: res.statusCode ?? 0,
    body,
    cacheControl: (res.headers['cache-control'] as string | undefined) ?? null,
    contentType: (res.headers['content-type'] as string | undefined) ?? null,
  };
}

/** Both arms, in turn, with the input the fake handler was called with by each. */
async function both(r: Req) {
  const trpc = await get(trpcBase, r);
  const trpcCall = calls.handler.splice(0);
  const standalone = await get(standaloneBase, r);
  const standaloneCall = calls.handler.splice(0);
  return { trpc, standalone, trpcCall, standaloneCall };
}

type Golden = {
  request: { input: string; headers: Record<string, string>; session: { userId: number } | null };
};
const GOLDEN_DIR = join(process.cwd(), 'apps/feed-go/testdata/golden/as-posts');
const goldens: Array<[string, Req]> = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as Golden] as const)
  // A credentialed request is refused by the standalone arm on purpose (see its doc).
  .filter(([, g]) => !g.request.headers.authorization)
  .map(([f, g]) => [
    f,
    { input: g.request.input, host: g.request.headers.host, userId: g.request.session?.userId },
  ]);

describe('standalone arm vs the tRPC route', () => {
  it('reads the golden inputs (not an empty directory)', () => {
    expect(goldens.length).toBeGreaterThanOrEqual(20);
    expect(goldens.some(([, r]) => r.userId)).toBe(true);
    expect(goldens.some(([, r]) => !r.userId)).toBe(true);
  });

  it.each(goldens)('%s: same status, bytes and Cache-Control', async (_name, r) => {
    const { trpc, standalone, trpcCall, standaloneCall } = await both(r);
    expect(trpc.status).toBe(200);
    expect(standalone).toEqual(trpc);
    expect(trpcCall).toHaveLength(1);
    expect(standaloneCall).toEqual(trpcCall);
    // The body is the handler's echo, not a constant: it names the input's model.
    const modelId = (JSON.parse(r.input!) as { json: { modelId: number } }).json.modelId;
    expect(trpc.body).toContain(`"modelId":${modelId}`);
  });

  it('no input at all: same answer', async () => {
    const { trpc, standalone, trpcCall, standaloneCall } = await both({
      host: 'blue.example.test',
    });
    expect(standalone).toEqual(trpc);
    expect(standaloneCall).toEqual(trpcCall);
  });

  it('an input the schema rejects is a 400 on both (error bodies are not compared)', async () => {
    const input = JSON.stringify({ json: { modelId: 'not-a-number', limit: 3 } });
    const { trpc, standalone, trpcCall, standaloneCall } = await both({
      input,
      host: 'blue.example.test',
    });
    expect(trpc.status).toBe(400);
    expect(standalone.status).toBe(400);
    expect(trpcCall).toEqual([]);
    expect(standaloneCall).toEqual([]);
  });

  // The domain cap, with literal levels: signed out is capped to PG (1); signed in on the SFW
  // (`green.`) host to PG + PG-13 (3); signed in elsewhere not at all (31 stays 31).
  it.each([
    ['signed out', 'green.example.test', undefined, 1, null],
    ['signed in, SFW host', 'green.example.test', 1003, 3, 1003],
    ['signed in, other host', 'blue.example.test', 1003, 31, 1003],
  ] as const)(
    '%s: both arms clamp browsingLevel 31 to %s',
    async (_, host, userId, level, viewer) => {
      const input = JSON.stringify({
        json: { modelId: 5001, modelVersionId: 6001, browsingLevel: 31, limit: 3 },
      });
      const { trpc, standalone, trpcCall, standaloneCall } = await both({ input, host, userId });
      expect(standalone).toEqual(trpc);
      expect(trpcCall.map((c) => [c.input.browsingLevel, c.viewer])).toEqual([[level, viewer]]);
      expect(standaloneCall.map((c) => [c.input.browsingLevel, c.viewer])).toEqual([
        [level, viewer],
      ]);
    }
  );

  it('signed out is edge-cacheable and signed in is not, on both (Cache-Control differs)', async () => {
    const input = JSON.stringify({ json: { modelId: 5001, limit: 3 } });
    const out = await both({ input, host: 'blue.example.test' });
    const inn = await both({ input, host: 'blue.example.test', userId: 1003 });
    expect(out.standalone.cacheControl).toBe(out.trpc.cacheControl);
    expect(inn.standalone.cacheControl).toBe(inn.trpc.cacheControl);
    expect(out.trpc.cacheControl).not.toBe(inn.trpc.cacheControl);
  });

  it('negative control: two different inputs give different bodies', async () => {
    const a = await get(standaloneBase, { input: goldens[0][1].input, host: 'blue.example.test' });
    const b = await get(standaloneBase, { input: goldens[1][1].input, host: 'blue.example.test' });
    expect(a.status).toBe(200);
    expect(a.body).not.toBe(b.body);
  });

  it('refuses an API credential instead of serving it unscoped', async () => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        `${standaloneBase}/api/trpc/${PROCEDURE}`,
        { headers: { host: 'blue.example.test', authorization: 'Bearer not-a-key' } },
        resolve
      );
      req.on('error', reject);
      req.end();
    });
    res.resume();
    expect(res.statusCode).toBe(400);
    expect(calls.handler).toEqual([]);
  });

  it('answers 404 for any other path', async () => {
    const res = await fetch(`${standaloneBase}/api/trpc/image.getInfinite`);
    expect(res.status).toBe(404);
  });
});

describe('the page module the standalone server loads', () => {
  it('carries serveImagesAsPostsStandalone on its default export, which itself answers 404', async () => {
    const page = (await import('~/pages/api/internal/feed-bench')).default;
    const { serveImagesAsPostsStandalone } = await import(
      '~/server/feed-bench/images-as-posts-standalone'
    );
    expect(page.serveImagesAsPostsStandalone).toBe(serveImagesAsPostsStandalone);
    const res = { status: vi.fn(() => res), end: vi.fn() };
    page({} as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
  });
});
