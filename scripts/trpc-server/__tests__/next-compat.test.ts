import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the router-server / base-server behaviour the standalone tRPC server ports
 * (`scripts/trpc-server/next-compat.cjs`). Expectations are the literal answers Next gives; the
 * full request-by-request comparison against a real `server.js` is the parity job
 * (`.github/workflows/trpc-server-parity.yml`).
 */

const require = createRequire(import.meta.url);
const compat = require('../next-compat.cjs');

// The shape `next build` writes for this app's config: i18n with one locale, the internal
// trailing-slash redirect, one user redirect, and the X-Frame-Options header rule. The redirects
// are present to show they are NOT applied: this server does not port them.
const routesManifest = {
  redirects: [
    {
      source: '/:path+/',
      destination: '/:path+',
      locale: false,
      internal: true,
      priority: true,
      statusCode: 308,
    },
    {
      source: '/:nextInternalLocale(en)/old-page',
      destination: '/new-page',
      statusCode: 301,
    },
  ],
  headers: [
    {
      source: '/:nextInternalLocale(en)/gift-cards',
      headers: [{ key: 'Content-Security-Policy', value: "frame-src 'self'" }],
    },
    {
      source: '/:nextInternalLocale(en)/((?!gift-cards).*)',
      headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
    },
  ],
  rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
  onMatchHeaders: [],
};
const nextConfig = { i18n: { locales: ['en'], defaultLocale: 'en' } };

function route(url: string) {
  const routing = compat.createRouting({ routesManifest, nextConfig });
  return compat.resolveRouting(routing, { url, headers: {} });
}

describe('resolveRouting', () => {
  it('applies the config headers to a tRPC path, matched with the default locale added', () => {
    expect(route('/api/trpc/content.get?input=%7B%7D')).toEqual({
      headers: { 'X-Frame-Options': 'DENY' },
    });
  });

  it('applies no redirect: a trailing-slash, repeated-slash or user-redirected path gets headers only', () => {
    const headersOnly = { headers: { 'X-Frame-Options': 'DENY' } };
    expect(route('/api/trpc/content.get/?batch=1')).toEqual(headersOnly);
    expect(route('/api/trpc//content.get?x=1')).toEqual(headersOnly);
    expect(route('/old-page')).toEqual(headersOnly);
  });

  it('refuses to start on a manifest feature it does not implement', () => {
    expect(() =>
      compat.createRouting({
        routesManifest: {
          ...routesManifest,
          rewrites: {
            beforeFiles: [{ source: '/a', destination: '/b' }],
            afterFiles: [],
            fallback: [],
          },
        },
        nextConfig,
      })
    ).toThrow('beforeFiles rewrites are not supported');
  });
});

// This server does not port `redirects()` or rewrites. That is only safe while none of them can
// apply to a page it serves, so createRouting refuses to start when one could (`pages` is the
// served list). The checks go both ways: each served page's example paths against every source,
// and each source's literal shape against the served pages.
describe('createRouting refuses a redirect or rewrite that reaches a served page', () => {
  const PAGES = ['/api/trpc/[trpc]', '/api/v1/models/[id]', '/api/v1/content/[[...slug]]'];
  const build = (extra: Record<string, unknown>) => () =>
    compat.createRouting({
      routesManifest: { ...routesManifest, ...extra },
      nextConfig,
      pages: PAGES,
    });

  it('accepts the real-shaped manifest (internal trailing-slash redirect, a page redirect)', () => {
    expect(build({})).not.toThrow();
  });

  it('refuses a user redirect whose source matches a served dynamic page', () => {
    const redirects = [
      ...routesManifest.redirects,
      { source: '/:nextInternalLocale(en)/api/v1/models/:id', destination: '/x', statusCode: 301 },
    ];
    expect(build({ redirects })).toThrow(
      /redirect .*\/api\/v1\/models\/:id.*\/api\/v1\/models\/\[id\]/
    );
  });

  it('refuses a literal redirect source that only one concrete value of a page matches', () => {
    const redirects = [
      { source: '/:nextInternalLocale(en)/api/v1/models/123', destination: '/x', statusCode: 301 },
    ];
    expect(build({ redirects })).toThrow(/redirect/);
  });

  it('refuses a redirect even when it is conditional (has/missing)', () => {
    const redirects = [
      {
        source: '/:nextInternalLocale(en)/api/v1/content',
        has: [{ type: 'host', value: 'example.com' }],
        destination: '/x',
        statusCode: 308,
      },
    ];
    expect(build({ redirects })).toThrow(/redirect/);
  });

  it.each(['afterFiles', 'fallback'])(
    'refuses an %s rewrite that reaches a served page',
    (kind) => {
      const rewrites = {
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
        [kind]: [{ source: '/:nextInternalLocale(en)/api/trpc/:p', destination: '/y' }],
      };
      expect(build({ rewrites })).toThrow(/rewrite/);
    }
  );

  it('refuses an array-form (afterFiles) rewrite too', () => {
    expect(build({ rewrites: [{ source: '/api/v1/:path*', destination: '/y' }] })).toThrow(
      /rewrite/
    );
  });

  it('accepts a redirect and a rewrite that reach no served page', () => {
    const redirects = [
      ...routesManifest.redirects,
      { source: '/:nextInternalLocale(en)/api/v2/a', destination: '/b', statusCode: 301 },
    ];
    const rewrites = {
      beforeFiles: [],
      afterFiles: [{ source: '/:nextInternalLocale(en)/blog/:slug', destination: '/p' }],
      fallback: [],
    };
    expect(build({ redirects, rewrites })).not.toThrow();
  });
});

// Next's proxy reads a non-GET/HEAD request body through a clone capped at
// `experimental.proxyClientMaxBodySize` (default 10 MiB): past the cap it stops copying and the
// route then sees the truncated body (`getCloneableBody` in next/dist/server/body-streams). The
// standalone server must do the same for the pages it applies the proxy's policy to.
describe('applyProxyBodyLimit', () => {
  function request(method: string, chunks: Buffer[]) {
    const req = Readable.from(chunks) as Readable & { method: string; url: string };
    req.method = method;
    req.url = '/api/v1/x';
    return req;
  }
  async function readAll(r: Readable) {
    const out: Buffer[] = [];
    for await (const c of r) out.push(Buffer.from(c));
    return Buffer.concat(out);
  }
  const KiB = Buffer.alloc(1024, 0x61);

  it('truncates a POST body past the configured cap at a chunk boundary, as Next does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const req = request(
      'POST',
      Array.from({ length: 10 }, () => KiB)
    );
    await compat.applyProxyBodyLimit(req, { experimental: { proxyClientMaxBodySize: 4096 + 100 } });
    expect((await readAll(req)).length).toBe(4096);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('uses Next default of 10 MiB when the config sets none', async () => {
    const req = request(
      'PUT',
      Array.from({ length: 10 * 1024 + 2 }, () => KiB)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await compat.applyProxyBodyLimit(req, {});
    expect((await readAll(req)).length).toBe(10 * 1024 * 1024);
    warn.mockRestore();
  });

  it('passes a body under the cap through whole', async () => {
    const req = request('POST', [KiB, KiB]);
    await compat.applyProxyBodyLimit(req, { experimental: { proxyClientMaxBodySize: 4096 } });
    expect((await readAll(req)).length).toBe(2048);
  });

  it('leaves GET and HEAD alone (Next clones no body for them)', async () => {
    for (const method of ['GET', 'HEAD']) {
      const req = request(
        method,
        Array.from({ length: 10 }, () => KiB)
      );
      await compat.applyProxyBodyLimit(req, { experimental: { proxyClientMaxBodySize: 1024 } });
      expect((await readAll(req)).length).toBe(10 * 1024);
    }
  });
});

// One page module that throws while loading must not take the server down with it: like Next's
// own preload, the failure is logged and the page is retried on request (a failing load answers 500
// through the server's request error path), while every other page serves.
describe('createRouteModuleLoader', () => {
  const good = { handler: () => undefined };
  function loader(behaviour: Record<string, () => unknown>) {
    const calls: string[] = [];
    const log = vi.fn();
    const load = async (page: string) => {
      calls.push(page);
      return behaviour[page]();
    };
    return { calls, log, modules: compat.createRouteModuleLoader(load, log) };
  }

  it('preloads every page, logs and reports the ones that fail, and keeps the rest', async () => {
    const { log, modules } = loader({
      '/a': () => good,
      '/b': () => {
        throw new Error('boom');
      },
      '/c': () => ({}),
    });
    expect(await modules.preload(['/a', '/b', '/c'])).toEqual(['/b', '/c']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(await modules.get('/a')).toBe(good);
  });

  it('retries a failed page on request: a failure rejects, a later success is kept', async () => {
    let fail = true;
    const { calls, modules } = loader({
      '/b': () => {
        if (fail) throw new Error('boom');
        return good;
      },
    });
    await modules.preload(['/b']);
    await expect(modules.get('/b')).rejects.toThrow('boom');
    fail = false;
    expect(await modules.get('/b')).toBe(good);
    expect(await modules.get('/b')).toBe(good);
    expect(calls).toEqual(['/b', '/b', '/b']);
  });

  it('rejects a module with no handler export on request, naming the page', async () => {
    const { modules } = loader({ '/c': () => ({}) });
    await expect(modules.get('/c')).rejects.toThrow('/c has no exported handler(req, res, ctx)');
  });
});

describe('stripInternalQuery', () => {
  // A route module invoked directly takes `nxtP<param>` as the route param; Next drops it.
  it('removes nxtP/nxtI keys and nextInternalLocale, and nothing else', () => {
    const req = {
      url: '/api/trpc/content.get?input=1&nxtPtrpc=user.delete&nxtIfoo=2&nextInternalLocale=en&nxtP=3&b=4',
    };
    compat.stripInternalQuery(req);
    expect(req.url).toBe('/api/trpc/content.get?input=1&nxtP=3&b=4');
  });

  it('leaves a URL without internal keys byte-for-byte unchanged', () => {
    const url = '/api/trpc/a,b?batch=1&input=%7B%220%22%3A%7B%7D%7D';
    const req = { url };
    compat.stripInternalQuery(req);
    expect(req.url).toBe(url);
  });
});

describe('fillForwardedHeaders', () => {
  it('fills what a direct client did not send, from the socket and the listen port', () => {
    const req = {
      headers: { host: 'localhost:3000' } as Record<string, string>,
      socket: { encrypted: false, remoteAddress: '10.1.2.3' },
    };
    compat.fillForwardedHeaders(req, { hostname: '0.0.0.0', port: 3000 });
    expect(req.headers).toEqual({
      host: 'localhost:3000',
      'x-forwarded-host': 'localhost:3000',
      'x-forwarded-port': '3000',
      'x-forwarded-proto': 'http',
      'x-forwarded-for': '10.1.2.3',
    });
  });

  it('never overwrites a value the request carried', () => {
    const headers = {
      host: 'a.example',
      'x-forwarded-host': 'b.example',
      'x-forwarded-port': '443',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '198.51.100.1, 10.0.0.1',
    };
    const req = {
      headers: { ...headers },
      socket: { encrypted: false, remoteAddress: '10.9.9.9' },
    };
    compat.fillForwardedHeaders(req, { hostname: '0.0.0.0', port: 3000 });
    expect(req.headers).toEqual(headers);
  });
});

describe('createPageMatcher', () => {
  const match = compat.createPageMatcher(['/api/trpc/[trpc]', '/api/live']);

  it('matches one tRPC segment, including a comma-separated batch', () => {
    expect(match('/api/trpc/a.b,c.d')).toEqual({ page: '/api/trpc/[trpc]' });
    expect(match('/api/live')).toEqual({ page: '/api/live' });
  });

  it('does not serve a multi-segment path or a locale-prefixed API path', () => {
    expect(match('/api/trpc/a/b')).toEqual({ notFound: true });
    expect(match('/api/trpc//a')).toEqual({ notFound: true });
    expect(match('/en/api/live')).toEqual({ notFound: true });
  });

  // Next 308s these before any route runs; this server answers them 404 rather than serving them.
  it('does not serve a trailing-slash path, static or dynamic', () => {
    expect(match('/api/trpc/a.b/')).toEqual({ notFound: true });
    expect(match('/api/live/')).toEqual({ notFound: true });
  });

  it('reports an undecodable % escape instead of matching', () => {
    expect(match('/api/trpc/%E0%A4%A')).toEqual({ decodeError: true });
  });
});

describe('createPageMatcher with the image-delivery page', () => {
  const PAGE = '/api/internal/image-delivery/[id]';
  const match = compat.createPageMatcher(['/api/trpc/[trpc]', PAGE]);

  it('serves one id segment, including an encoded slash', () => {
    expect(match('/api/internal/image-delivery/0d1e2f3a-4b5c-4d6e-8f70-000000000001')).toEqual({
      page: PAGE,
    });
    expect(match('/api/internal/image-delivery/a%20b%2Fc')).toEqual({ page: PAGE });
  });

  it('does not serve no id, more segments, a trailing slash or another prefix', () => {
    expect(match('/api/internal/image-delivery/')).toEqual({ notFound: true });
    expect(match('/api/internal/image-delivery/a/b')).toEqual({ notFound: true });
    expect(match('/api/internal/image-delivery/a/')).toEqual({ notFound: true });
    expect(match('/api/internal/image-deliveryx/a')).toEqual({ notFound: true });
  });

  it('reports an undecodable % escape', () => {
    expect(match('/api/internal/image-delivery/%E0%A4%A')).toEqual({ decodeError: true });
  });
});

// The `api` profile serves many dynamic pages, some of which can match the same path. Next tries
// them in `getSortedRoutes` order; the list is given here in the WRONG order on purpose, so a
// matcher that tried pages in list order would pick the catch-all.
describe('createPageMatcher with overlapping dynamic pages', () => {
  const match = compat.createPageMatcher([
    '/api/t/[...rest]',
    '/api/t/[id]',
    '/api/t/fixed',
    '/api/t/[id]/sub',
  ]);

  it('prefers a static page, then one dynamic segment, then a catch-all, as Next does', () => {
    expect(match('/api/t/fixed')).toEqual({ page: '/api/t/fixed' });
    expect(match('/api/t/1')).toEqual({ page: '/api/t/[id]' });
    expect(match('/api/t/1/sub')).toEqual({ page: '/api/t/[id]/sub' });
    expect(match('/api/t/1/2')).toEqual({ page: '/api/t/[...rest]' });
  });
});

// INVARIANT GUARD, not a regression test for the sort: none of these real pages overlap, so the
// order they are tried in cannot change any answer below (a matcher without the sort passes it
// too). It pins how real api-profile paths route; the sort itself is pinned by the block above.
describe('createPageMatcher with real api-profile pages (invariant guard)', () => {
  const match = compat.createPageMatcher([
    '/api/v1/content/[[...slug]]',
    '/api/v1/models/[id]',
    '/api/v1/models/com-face',
    '/api/v1/model-versions/[id]',
    '/api/v1/model-versions/by-hash/[hash]',
    '/api/v1/model-versions/mini/[id]',
    '/api/auth/oauth/[...path]',
  ]);

  it('routes each path to the page Next would', () => {
    expect(match('/api/v1/models/com-face')).toEqual({ page: '/api/v1/models/com-face' });
    expect(match('/api/v1/models/42')).toEqual({ page: '/api/v1/models/[id]' });
    expect(match('/api/v1/model-versions/by-hash/ABC')).toEqual({
      page: '/api/v1/model-versions/by-hash/[hash]',
    });
    expect(match('/api/v1/model-versions/mini/7')).toEqual({
      page: '/api/v1/model-versions/mini/[id]',
    });
    expect(match('/api/v1/content')).toEqual({ page: '/api/v1/content/[[...slug]]' });
    expect(match('/api/v1/content/a/b')).toEqual({ page: '/api/v1/content/[[...slug]]' });
    expect(match('/api/auth/oauth/x/y')).toEqual({ page: '/api/auth/oauth/[...path]' });
  });

  it('still does not serve a trailing slash or an unlisted path', () => {
    expect(match('/api/v1/models/42/')).toEqual({ notFound: true });
    expect(match('/api/v1/content/')).toEqual({ notFound: true });
    expect(match('/api/v1/nope')).toEqual({ notFound: true });
    expect(match('/api/auth/oauth')).toEqual({ notFound: true });
  });
});

describe('filterInternalHeaders', () => {
  it('deletes the client-sent internal headers Next never honours', () => {
    const headers: Record<string, string> = {
      'x-middleware-override-headers': 'a',
      'x-matched-path': '/x',
      'x-nextjs-data': '1',
      'x-now-route-matches': 'a=1',
      'user-agent': 'ua',
    };
    compat.filterInternalHeaders(headers);
    expect(headers).toEqual({ 'user-agent': 'ua' });
  });
});

describe('Next exports checked at load', () => {
  /**
   * Loads a FRESH copy of next-compat while one Next module's export is replaced, and returns the
   * error it threw (or null). The real module is put back before returning. This uses Node's own
   * require cache, which is what next-compat's `require` reads.
   */
  function loadErrorWithExport(specifier: string, name: string, value: unknown): Error | null {
    const self = require.resolve('../next-compat.cjs');
    const key = require.resolve(specifier, { paths: [self] });
    require(key); // the real module, cached
    const real = require.cache[key];
    if (!real) throw new Error(`${specifier} was not cached`);
    const fake = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      exports: { ...real.exports, [name]: value },
    });
    require.cache[key] = fake;
    delete require.cache[self];
    try {
      require(self);
      return null;
    } catch (err) {
      return err as Error;
    } finally {
      require.cache[key] = real;
      delete require.cache[self];
    }
  }

  it('throws, naming the export, when a Next function is missing', () => {
    const err = loadErrorWithExport(
      'next/dist/shared/lib/router/utils/route-matcher',
      'getRouteMatcher',
      undefined
    );
    expect(err?.message).toContain(
      'next/dist/shared/lib/router/utils/route-matcher no longer exports getRouteMatcher as a function'
    );
  });

  it('throws when a Next constant is present but empty', () => {
    const err = loadErrorWithExport('next/dist/lib/constants', 'NEXT_QUERY_PARAM_PREFIX', '');
    expect(err?.message).toContain(
      'next/dist/lib/constants no longer exports NEXT_QUERY_PARAM_PREFIX as a non-empty string'
    );
  });

  it('loads cleanly when nothing is replaced (positive control for the helper above)', () => {
    const err = loadErrorWithExport(
      'next/dist/lib/constants',
      'NEXT_QUERY_PARAM_PREFIX',
      require('next/dist/lib/constants').NEXT_QUERY_PARAM_PREFIX
    );
    expect(err).toBeNull();
  });
});
