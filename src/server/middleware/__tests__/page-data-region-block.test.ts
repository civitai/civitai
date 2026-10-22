import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from '~/proxy';
import { runMiddlewares } from '~/server/middleware';

/**
 * `GET /api/page-data/*` answers with a viewer's session and page data, so a blocked region must be
 * refused there exactly as on the page it feeds. `apiRegionBlockMiddleware` matches every `/api`
 * path, but it only runs where the PROXY runs, and the proxy's own matcher excludes `/api` except
 * for the prefixes it lists. Both halves are pinned: the proxy reaches the path, and the chain
 * answers 451 there.
 */

const PAGE_DATA = '/api/page-data/images/123';

describe('region blocking on the page-data endpoint', () => {
  it('the proxy runs on page-data paths', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: PAGE_DATA })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: `${PAGE_DATA}?postId=5` })).toBe(true);
  });

  it('control: the proxy does not run on an /api path it does not list', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: '/api/user/settings' })).toBe(false);
  });

  it('a blocked region gets 451 from the middleware chain', async () => {
    const response = await runMiddlewares(
      new NextRequest(`http://localhost${PAGE_DATA}`, { headers: { 'cf-ipcountry': 'GB' } })
    );
    expect(response.status).toBe(451);
    expect(await response.json()).toMatchObject({ code: 'REGION_BLOCKED' });
  });

  it('control: an allowed region passes through to the route', async () => {
    const response = await runMiddlewares(
      new NextRequest(`http://localhost${PAGE_DATA}`, { headers: { 'cf-ipcountry': 'US' } })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
