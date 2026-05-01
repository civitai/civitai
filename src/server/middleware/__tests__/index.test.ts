import { describe, it, expect } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { runMiddlewares } from '../index';
import { createMiddleware, type Middleware } from '../middleware-utils';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

describe('runMiddlewares', () => {
  // The regression we just fixed: apiCacheMiddleware returns a passthrough
  // NextResponse.next() with Cache-Control on the response, and was
  // short-circuiting the chain before botDetectionMiddleware could run.
  // Now the runner accumulates response headers from passthroughs and
  // merges them into the terminal-with-request-mods response.
  it('merges Cache-Control from a passthrough into a later request-modifying passthrough', async () => {
    const apiCacheLike = createMiddleware({
      matcher: ['/api/:path*'],
      handler: async () => {
        const r = NextResponse.next();
        r.headers.set('Cache-Control', 'max-age=0, private, no-cache');
        return r;
      },
    });
    const botDetectionLike = createMiddleware({
      matcher: ['/api/:path*'],
      handler: async ({ request }) => {
        const headers = new Headers(request.headers);
        headers.set('x-civitai-verified-bot', 'googlebot');
        return NextResponse.next({ request: { headers } });
      },
    });

    const response = await runMiddlewares(makeRequest('/api/trpc/image.getInfinite'), [
      apiCacheLike,
      botDetectionLike,
    ]);

    // apiCacheLike's Cache-Control survived
    expect(response.headers.get('Cache-Control')).toBe('max-age=0, private, no-cache');
    // botDetectionLike's request-header override survived
    const overrideList = response.headers.get('x-middleware-override-headers');
    expect(overrideList).toMatch(/x-civitai-verified-bot/);
    expect(response.headers.get('x-middleware-request-x-civitai-verified-bot')).toBe('googlebot');
  });

  it('terminal redirects short-circuit subsequent middlewares', async () => {
    let secondRan = false;
    const redirector = createMiddleware({
      matcher: ['/:path*'],
      handler: async ({ redirect }) => redirect('/elsewhere'),
    });
    const second = createMiddleware({
      matcher: ['/:path*'],
      handler: async () => {
        secondRan = true;
      },
    });

    const response = await runMiddlewares(makeRequest('/some-path'), [redirector, second]);
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(secondRan).toBe(false);
  });

  it('applies accumulated response headers to a later terminal redirect', async () => {
    const headerSetter = createMiddleware({
      matcher: ['/:path*'],
      handler: async () => {
        const r = NextResponse.next();
        r.headers.set('X-Custom', 'value-from-passthrough');
        return r;
      },
    });
    const redirector = createMiddleware({
      matcher: ['/:path*'],
      handler: async ({ redirect }) => redirect('/elsewhere'),
    });

    const response = await runMiddlewares(makeRequest('/some-path'), [headerSetter, redirector]);
    expect(response.headers.get('X-Custom')).toBe('value-from-passthrough');
    expect(response.status).toBeGreaterThanOrEqual(300);
  });

  it('returns a fresh passthrough with accumulated headers when no middleware terminates', async () => {
    const headerSetter = createMiddleware({
      matcher: ['/:path*'],
      handler: async () => {
        const r = NextResponse.next();
        r.headers.set('X-Custom', 'accumulated');
        return r;
      },
    });
    const noop = createMiddleware({
      matcher: ['/:path*'],
      handler: async () => {
        // void — pass through
      },
    });

    const response = await runMiddlewares(makeRequest('/some-path'), [headerSetter, noop]);
    expect(response.headers.get('X-Custom')).toBe('accumulated');
    // The runner returned NextResponse.next() (passthrough marker present).
    // If a future Next.js version renames this internal header, this assertion
    // catches it — and the runner's isPassthrough check would silently break
    // without it.
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('passthrough with request modifications alone (no accumulated) returns request override headers', async () => {
    const botDetectionLike = createMiddleware({
      matcher: ['/:path*'],
      handler: async ({ request }) => {
        const headers = new Headers(request.headers);
        headers.set('x-civitai-verified-bot', 'googlebot');
        return NextResponse.next({ request: { headers } });
      },
    });

    const response = await runMiddlewares(makeRequest('/models/123'), [botDetectionLike]);
    expect(response.headers.get('x-middleware-override-headers')).toMatch(/x-civitai-verified-bot/);
    expect(response.headers.get('x-middleware-request-x-civitai-verified-bot')).toBe('googlebot');
  });

  it('skips middlewares whose shouldRun returns false', async () => {
    let firstRan = false;
    let secondRan = false;
    const skipped = createMiddleware({
      matcher: ['/api/:path*'],
      shouldRun: () => false,
      handler: async () => {
        firstRan = true;
      },
    });
    const ran = createMiddleware({
      matcher: ['/:path*'],
      handler: async () => {
        secondRan = true;
      },
    });

    await runMiddlewares(makeRequest('/api/trpc/foo'), [skipped, ran]);
    expect(firstRan).toBe(false);
    expect(secondRan).toBe(true);
  });
});
