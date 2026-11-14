import type { NextApiRequest, NextApiResponse } from 'next';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';
import { botDetectionMiddleware } from '~/server/middleware/bot-detection.middleware';
import { runMiddlewares } from '~/server/middleware/index';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';

/**
 * Crawler treatment needs the edge-set header as well as a crawler user agent from a crawler IP.
 * Each case runs through both places that decide it: the proxy and the route-side policy.
 */

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
// In a googlebot-ips.json range.
const GOOGLEBOT_IP = '192.178.4.1';
const EDGE_HEADER = 'x-civ-cf-verified-bot';
const SECRET = 'edge-header-unit-secret-91c2';

function crawlerHeaders(edgeValue?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': GOOGLEBOT,
    'cf-connecting-ip': GOOGLEBOT_IP,
    // Sent by the client: must not survive unless the request verifies.
    [VERIFIED_BOT_HEADER]: 'googlebot',
  };
  if (edgeValue !== undefined) headers[EDGE_HEADER] = edgeValue;
  return headers;
}

async function botSeenViaProxy(path: string, headers: Record<string, string>) {
  const request = new NextRequest(`https://civitai.red${path}`, { headers });
  const response = await runMiddlewares(request, [botDetectionMiddleware]);
  const overrides = response.headers.get('x-middleware-override-headers');
  if (overrides === null) return request.headers.get(VERIFIED_BOT_HEADER);
  if (!overrides.split(',').includes(VERIFIED_BOT_HEADER)) return null;
  return response.headers.get(`x-middleware-request-${VERIFIED_BOT_HEADER}`);
}

function botSeenViaRoute(path: string, headers: Record<string, string>) {
  const req = { url: path, method: 'GET', headers: { ...headers } } as unknown as NextApiRequest;
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() } as unknown as NextApiResponse;
  applyApiRequestPolicy(req, res);
  return (req.headers[VERIFIED_BOT_HEADER] as string | undefined) ?? null;
}

const SURFACES = [
  ['proxy', '/images/123', botSeenViaProxy],
  ['route', '/api/v1/images', botSeenViaRoute],
] as const;

beforeEach(() => {
  resetEnv();
  setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: SECRET });
});

describe.each(SURFACES)('crawler treatment via the %s', (_surface, path, botSeen) => {
  it('is refused without the edge header', async () => {
    expect(await botSeen(path, crawlerHeaders())).toBeNull();
  });

  it.each([
    ['a wrong value', 'guess'],
    ['a longer value', `${SECRET}x`],
    ['an empty value', ''],
  ])('is refused with %s in the edge header', async (_name, value) => {
    expect(await botSeen(path, crawlerHeaders(value))).toBeNull();
  });

  it('control: is given with the right edge header', async () => {
    expect(await botSeen(path, crawlerHeaders(SECRET))).toBe('googlebot');
  });

  it.each([undefined, ''])('is refused when the secret is unset (%s)', async (secret) => {
    setEnv({ CF_VERIFIED_BOT_HEADER_SECRET: secret });
    expect(await botSeen(path, crawlerHeaders(SECRET))).toBeNull();
    expect(await botSeen(path, crawlerHeaders(''))).toBeNull();
  });
});
