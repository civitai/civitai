import { describe, expect, it } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { runMiddlewares } from '../index';
import { createMiddleware } from '../middleware-utils';
import { syncAccountNoindexMiddleware } from '../sync-account-noindex.middleware';

const run = (path: string) =>
  runMiddlewares(new NextRequest(`https://civitai.red${path}`), [syncAccountNoindexMiddleware]);

describe('syncAccountNoindexMiddleware', () => {
  it('marks a page carrying sync-account noindex', async () => {
    const response = await run('/models/1?sync-account=green');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('leaves the same page without the marker indexable', async () => {
    const response = await run('/models/1');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('skips api routes', async () => {
    const response = await run('/api/auth/authorize?sync-account=green');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('survives a later middleware that rewrites request headers', async () => {
    const botDetectionLike = createMiddleware({
      matcher: ['/:path*'],
      handler: async ({ request }) => {
        const headers = new Headers(request.headers);
        headers.set('x-civitai-verified-bot', 'googlebot');
        return NextResponse.next({ request: { headers } });
      },
    });
    const response = await runMiddlewares(
      new NextRequest('https://civitai.red/?sync-account=green'),
      [syncAccountNoindexMiddleware, botDetectionLike]
    );
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});
