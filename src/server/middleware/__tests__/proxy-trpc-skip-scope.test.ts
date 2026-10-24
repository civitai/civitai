import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '~/proxy';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';

/**
 * With `trpc-skip-proxy-middleware` ON the proxy hands `/api/trpc/*` straight through, because the
 * tRPC route applies the API policy itself. Every OTHER path the proxy matches has no such
 * route-side copy, so the skip must stay scoped to the tRPC prefix: with the flag ON, a blocked
 * region on `/api/v1`, `/api/page-data` or a page must still be refused by the proxy, and a client
 * that sends the verified-crawler header must still have it dropped. These call the real `proxy()`
 * with the flag forced ON; the tRPC cases are the control that the flag really is ON (the proxy
 * skips there) and that the skip is the flag's doing (OFF, the same request gets the 451).
 */

let flagOn = true;
vi.mock('~/server/flipt/global-sync', () => ({
  isGlobalFliptFlagOn: (flag: string) => flag === 'trpc-skip-proxy-middleware' && flagOn,
}));

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
// In no crawler range.
const OTHER_IP = '203.0.113.9';

function request(path: string, headers: Record<string, string>) {
  return new NextRequest(`http://localhost${path}`, { headers });
}

const BLOCKED = { 'cf-ipcountry': 'GB', 'user-agent': BROWSER };

beforeEach(() => {
  flagOn = true;
});

describe('trpc-skip-proxy-middleware ON leaves non-tRPC paths to the proxy chain', () => {
  it.each(['/api/v1/models', '/api/page-data/images/123'])(
    'a blocked region on %s still gets the 451',
    async (path) => {
      const response = await proxy(request(path, BLOCKED));
      expect(response.status).toBe(451);
      expect(await response.json()).toMatchObject({ code: 'REGION_BLOCKED' });
    }
  );

  it('a blocked region on a page is still redirected to /region-blocked', async () => {
    const response = await proxy(request('/images/123', BLOCKED));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/region-blocked');
  });

  it('a verified-crawler header a client sends to /api/v1 is still dropped', async () => {
    const response = await proxy(
      request('/api/v1/models', {
        'cf-ipcountry': 'US',
        'user-agent': BROWSER,
        'cf-connecting-ip': OTHER_IP,
        [VERIFIED_BOT_HEADER]: 'googlebot',
      })
    );
    // Control: the chain rewrote the request headers, so the absence below is a deletion.
    const overrides = response.headers.get('x-middleware-override-headers');
    expect(overrides).not.toBeNull();
    expect(overrides!.split(',')).not.toContain(VERIFIED_BOT_HEADER);
    expect(response.headers.get(`x-middleware-request-${VERIFIED_BOT_HEADER}`)).toBeNull();
  });

  it('control: a blocked region on /api/trpc is passed straight through', async () => {
    const response = await proxy(request('/api/trpc/model.getById', BLOCKED));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    // A bare passthrough: none of the chain's headers were applied.
    expect(response.headers.get('cache-control')).toBeNull();
    expect(response.headers.get('x-middleware-override-headers')).toBeNull();
  });

  it('control: with the flag OFF the same /api/trpc request gets the 451 from the proxy', async () => {
    flagOn = false;
    const response = await proxy(request('/api/trpc/model.getById', BLOCKED));
    expect(response.status).toBe(451);
  });
});
