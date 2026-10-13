import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { botDetectionMiddleware } from '~/server/middleware/bot-detection.middleware';
import { runMiddlewares } from '~/server/middleware/index';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';

/**
 * The verified-crawler header widens what a signed-out request is served, so only
 * `botDetectionMiddleware` may set it. A request that arrives already carrying it, from a client
 * that is not a verified crawler, must reach the app without it.
 */

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
// GOOGLEBOT_IP is in a googlebot-ips.json range; OTHER_IP is in no crawler range.
const GOOGLEBOT_IP = '192.178.4.1';
const OTHER_IP = '203.0.113.9';

function requestTo(
  path: string,
  carriesHeader: boolean | string,
  { ua = BROWSER, ip = OTHER_IP }: { ua?: string; ip?: string } = {}
) {
  const headers = new Headers({ 'user-agent': ua, 'cf-connecting-ip': ip });
  if (carriesHeader)
    headers.set(VERIFIED_BOT_HEADER, carriesHeader === true ? 'googlebot' : carriesHeader);
  return new NextRequest(`https://civitai.red${path}`, { headers });
}

// What the app will see for the header after the middleware chain: Next applies
// `x-middleware-request-*` overrides, and drops any request header the override list omits.
function headerSeenByApp(response: Response, request: NextRequest) {
  const overrides = response.headers.get('x-middleware-override-headers');
  if (overrides === null) return request.headers.get(VERIFIED_BOT_HEADER);
  if (!overrides.split(',').includes(VERIFIED_BOT_HEADER)) return null;
  return response.headers.get(`x-middleware-request-${VERIFIED_BOT_HEADER}`);
}

describe('botDetectionMiddleware and an inbound crawler header', () => {
  it.each([
    ['an image detail page', '/images/123'],
    ['a tRPC call', '/api/trpc/image.get'],
    ['a public REST call', '/api/v1/images'],
    ['a listing page under a matched prefix', '/images'],
    ['the home page', '/'],
    ['a profile page', '/user/someone'],
  ])('drops the header a browser sent to %s', async (_, path) => {
    const request = requestTo(path, true);
    expect(botDetectionMiddleware.shouldRun?.(request)).toBe(true);
    const response = await runMiddlewares(request, [botDetectionMiddleware]);
    expect(headerSeenByApp(response, request)).toBeNull();
  });

  it('drops it for a crawler user agent from outside the crawler ranges', async () => {
    const request = requestTo('/images/123', true, { ua: GOOGLEBOT });
    const response = await runMiddlewares(request, [botDetectionMiddleware]);
    expect(headerSeenByApp(response, request)).toBeNull();
  });

  it.each([
    ['without one', false],
    ['with its own value', true],
    ['with a different value', 'bingbot'],
  ])('sets it for a verified crawler arriving %s', async (_, carriesHeader) => {
    const request = requestTo('/images/123', carriesHeader, { ua: GOOGLEBOT, ip: GOOGLEBOT_IP });
    const response = await runMiddlewares(request, [botDetectionMiddleware]);
    expect(headerSeenByApp(response, request)).toBe('googlebot');
  });

  it('verifies crawlers only on the paths that use it', async () => {
    const request = requestTo('/images', true, { ua: GOOGLEBOT, ip: GOOGLEBOT_IP });
    const response = await runMiddlewares(request, [botDetectionMiddleware]);
    expect(headerSeenByApp(response, request)).toBeNull();
  });

  it('leaves a request without the header untouched', async () => {
    const request = requestTo('/images/123', false);
    const response = await runMiddlewares(request, [botDetectionMiddleware]);
    expect(response.headers.get('x-middleware-override-headers')).toBeNull();
    expect(headerSeenByApp(response, request)).toBeNull();
  });
});
