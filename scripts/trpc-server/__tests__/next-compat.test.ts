import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

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
