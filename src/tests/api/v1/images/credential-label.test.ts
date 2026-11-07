import type { NextApiRequest, NextApiResponse } from 'next';
import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/**
 * `/api/v1/images` records `credential` on `images_search_request_duration_seconds`.
 *
 * The handler runs its REAL session lookup (`getApiAuthSession` → `getServerAuthSession`);
 * only the bearer-key lookup and the hub session read under it are stubbed, so the label is
 * derived from what auth actually left on `req.context`. One distinct expected value per
 * credential type: a label hard-coded to any one value fails the other three.
 */

const { getSessionFromBearerToken, getHubSession } = vi.hoisted(() => ({
  getSessionFromBearerToken: vi.fn(),
  getHubSession: vi.fn(),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  readSessionToken: () => undefined,
  readDeviceId: () => undefined,
}));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession,
  maybeRollHubCookie: vi.fn(),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  withoutHeldImages: vi.fn(async (items: unknown[]) => items),
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: vi.fn().mockReturnValue('US'),
  isRegionRestricted: vi.fn().mockReturnValue(false),
}));
vi.mock('request-ip', () => ({ default: { getClientIp: () => '127.0.0.1' } }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  PublicEndpoint: (handler: unknown) => handler,
}));

import { sessionCookieName } from '@civitai/auth';
import handler from '~/pages/api/v1/images/index';
import { ensureRegisterFeedImageExistenceCheckMetrics } from '~/server/metrics/feed-image-existence-check.metrics';

const { requestDurationSeconds } = ensureRegisterFeedImageExistenceCheckMetrics(client.register);

const GOOD_KEY = 'good-key-3e8d';
const GOOD_COOKIE = 'good-cookie-a17c';
const COOKIE = sessionCookieName(true);

function makeReq(
  url: string,
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {}
) {
  const query = Object.fromEntries(new URL(url, 'http://x').searchParams);
  return { method: 'GET', url, headers, cookies, query } as unknown as NextApiRequest;
}

function makeRes() {
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => res,
    getHeader: () => undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json: () => res,
    end: () => res,
  };
  return res as unknown as NextApiResponse & { statusCode: number };
}

/** `_count` of the REST route's series, keyed by its `credential` label. */
async function countsByCredential() {
  const metric = await requestDurationSeconds.get();
  const counts: Record<string, number> = {};
  for (const v of metric.values) {
    if (v.metricName !== 'images_search_request_duration_seconds_count') continue;
    if (v.labels.route !== 'api/v1/images') continue;
    counts[String(v.labels.credential)] = v.value;
  }
  return counts;
}

beforeEach(() => {
  getSessionFromBearerToken.mockReset();
  getSessionFromBearerToken.mockImplementation(async (token: string) =>
    token === GOOD_KEY
      ? {
          user: { id: 801 },
          apiKeyId: 55,
          apiKeyType: 'User',
          subject: { type: 'apiKey', id: 55 },
          tokenScope: 3,
          buzzLimit: null,
        }
      : null
  );
  getHubSession.mockReset();
  getHubSession.mockImplementation(async (req: NextApiRequest) =>
    req.cookies?.[COOKIE] === GOOD_COOKIE ? { user: { id: 802 } } : null
  );
  requestDurationSeconds.reset();
});

const CASES: [string, NextApiRequest, string][] = [
  ['no credential', makeReq('/api/v1/images'), 'anonymous'],
  [
    'an API key in the Authorization header',
    makeReq('/api/v1/images', { authorization: `Bearer ${GOOD_KEY}` }),
    'key_header',
  ],
  ['an API key in ?token=', makeReq(`/api/v1/images?token=${GOOD_KEY}`), 'key_param'],
  ['a session cookie', makeReq('/api/v1/images', {}, { [COOKIE]: GOOD_COOKIE }), 'cookie'],
];

describe('/api/v1/images duration histogram credential label', () => {
  it.each(CASES)('records %s', async (_name, req, expected) => {
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(await countsByCredential()).toEqual({ [expected]: 1 });
  });

  it('records each credential type under its own series', async () => {
    for (const [, req] of CASES) {
      // A fresh request each time: auth memoises the session on `req.context`.
      await handler({ ...req, context: undefined } as unknown as NextApiRequest, makeRes());
    }
    expect(await countsByCredential()).toEqual({
      anonymous: 1,
      key_header: 1,
      key_param: 1,
      cookie: 1,
    });
  });
});
