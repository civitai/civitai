import { beforeEach, describe, expect, it, vi } from 'vitest';

// `isProd` is a module-load constant, and under vitest NODE_ENV is 'test', so without
// this every guard trivially allows and the suite proves nothing about production
// behaviour. Force it true so these run the branch that actually ships.
vi.mock('~/env/other', () => ({
  isProd: true,
  isDev: false,
  isTest: false,
  isPreview: false,
}));

// This drives the REAL guard through `routeGuardsMiddleware.handler`, not the pure
// predicate. The predicate already has its own suite; what this covers is the wiring
// between them — matcher, `shouldRun`, and the `nextUrl` fields the guard reads. A
// review found that the tests for this feature all stopped at the module boundary,
// and the wiring is exactly where a working predicate can still fail to take effect.

type Redirected = { redirectedTo: string } | undefined;

function requestFor(url: string, headerOverrides: Record<string, string> = {}) {
  const nextUrl = new URL(url);
  // Default to the realistic shape: the proxy forwards the public host in a header
  // while the runtime's own view of the URL may be something internal.
  const headers: Record<string, string> = { host: nextUrl.hostname, ...headerOverrides };
  return {
    nextUrl,
    url,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as never;
}

async function run(url: string): Promise<Redirected> {
  const { routeGuardsMiddleware } = await import('~/server/middleware/route-guards.middleware');
  let redirectedTo: string | undefined;
  const response = await routeGuardsMiddleware.handler({
    request: requestFor(url),
    redirect: ((to: string) => {
      redirectedTo = to;
      return { status: 307 } as never;
    }) as never,
  });
  return response ? { redirectedTo: redirectedTo ?? '(unknown)' } : undefined;
}

async function shouldRun(url: string): Promise<boolean> {
  const { routeGuardsMiddleware } = await import('~/server/middleware/route-guards.middleware');
  return routeGuardsMiddleware.shouldRun?.(requestFor(url)) ?? true;
}

const STALL = '/api/testing/eventloop-stall';

beforeEach(() => {
  vi.resetModules();
});

describe('route guard wiring for the synthetic stall endpoint (isProd = true)', () => {
  it('the middleware is even selected for the path (positive control)', async () => {
    // If `shouldRun` were false the handler would never execute and every assertion
    // below would pass for the wrong reason.
    expect(await shouldRun(`https://pr-3752.civitaic.com${STALL}`)).toBe(true);
  });

  it('🔴 lets the stall endpoint through on a non-production host', async () => {
    expect(await run(`https://pr-3752.civitaic.com${STALL}`)).toBeUndefined();
  });

  it('🔴 still redirects the stall endpoint on the production host', async () => {
    expect(await run(`https://civitai.com${STALL}`)).toEqual({ redirectedTo: '/' });
  });

  it('🔴 still redirects every other testing route on a non-production host', async () => {
    for (const path of ['/api/testing/referrals', '/api/testing/gift-membership']) {
      expect(await run(`https://pr-3752.civitaic.com${path}`), path).toEqual({
        redirectedTo: '/',
      });
    }
  });

  it('🔴 allows when only the FORWARDED host is the preview host', async () => {
    // The live failure this was written for: `nextUrl.hostname` is whatever the
    // runtime resolved behind the proxy, which need not be the public host. If the
    // guard read `nextUrl.hostname` alone, this case redirects and the endpoint is
    // unreachable in preview while every unit test still passes.
    const { routeGuardsMiddleware } = await import('~/server/middleware/route-guards.middleware');
    const request = requestFor(`https://internal-service.local${STALL}`, {
      host: 'internal-service.local',
      'x-forwarded-host': 'pr-3752.civitaic.com',
    });

    const response = await routeGuardsMiddleware.handler({
      request,
      redirect: (() => ({ status: 307 })) as never,
    });

    expect(response).toBeUndefined();
  });

  it('carries the query string without affecting the decision', async () => {
    // The real call carries ?token=…; a guard reading `href` instead of `pathname`
    // would break on it and nothing else here would notice.
    expect(await run(`https://pr-3752.civitaic.com${STALL}?token=abc123`)).toBeUndefined();
  });
});
