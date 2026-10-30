import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from '~/proxy';
import { runMiddlewares } from '~/server/middleware';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';

/**
 * `GET /api/page-data/*` answers with a viewer's session and page data, so a blocked region must be
 * refused there exactly as on the page it feeds. `apiRegionBlockMiddleware` matches every `/api`
 * path, but it only runs where the PROXY runs, and the proxy's own matcher excludes `/api` except
 * for the prefixes it lists. Both halves are pinned: the proxy reaches the path, and the chain
 * answers 451 there.
 */

const PAGE_DATA = '/api/page-data/images/123';
// The shell's parallel main-image lookup: as viewer-specific, so blocked alike.
const MAIN_IMAGE = '/api/page-data/images/123/main-image';

describe('region blocking on the page-data endpoint', () => {
  it('the proxy runs on page-data paths', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: PAGE_DATA })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: `${PAGE_DATA}?postId=5` })).toBe(true);
  });

  it('the proxy runs on the main-image path, and a blocked region gets 451 there', async () => {
    expect(unstable_doesMiddlewareMatch({ config, url: MAIN_IMAGE })).toBe(true);
    const response = await runMiddlewares(
      new NextRequest(`http://localhost${MAIN_IMAGE}`, { headers: { 'cf-ipcountry': 'GB' } })
    );
    expect(response.status).toBe(451);
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

  // The other thing the proxy does for this path: only `botDetectionMiddleware` may set the
  // verified-bot header that `image.get` reads, so one a client sends is dropped before the route.
  it('drops a verified-bot header the client sent', async () => {
    const response = await runMiddlewares(
      new NextRequest(`http://localhost${PAGE_DATA}`, {
        headers: { 'cf-ipcountry': 'US', [VERIFIED_BOT_HEADER]: 'googlebot' },
      })
    );
    // Control: the chain did rewrite the request headers, so the absence below is a deletion.
    expect(response.headers.get('x-middleware-override-headers')).not.toBeNull();
    expect(response.headers.get('x-middleware-override-headers')).not.toContain(
      VERIFIED_BOT_HEADER
    );
    expect(response.headers.get(`x-middleware-request-${VERIFIED_BOT_HEADER}`)).toBeNull();
  });
});
