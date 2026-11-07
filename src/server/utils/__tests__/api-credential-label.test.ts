import { EventEmitter } from 'node:events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

/**
 * `apiCredentialLabel` and the `civitai_app_api_requests_total` counter it feeds.
 *
 * 🔴 The SEAM is the point. The label reads what `getServerAuthSession` leaves on
 * `req.context`, so these cases run the REAL `getServerAuthSession` — only the layers
 * below it (the bearer-key lookup and the hub session read) are stubbed. A fixture that
 * hand-wrote `req.context` would pin this reader against the author's idea of the
 * writer, and would stay green if auth stopped recording `tokenScope` on the key path.
 *
 * Every credential type maps to a DIFFERENT expected value, so a label hard-coded to any
 * one of them fails the other cases.
 */

const { getSessionFromBearerToken, getHubSession } = vi.hoisted(() => ({
  getSessionFromBearerToken: vi.fn(),
  getHubSession: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
}));
// Only the hub-cookie roll helpers are replaced; the cookie NAMES stay real, because
// `requestCarriesCallerCredentials` derives its list from them.
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
vi.mock('~/server/db/db-helpers', () => ({ checkNotUpToDate: vi.fn() }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: vi.fn(() => []) }));
vi.mock('~/server/prom/http-errors', () => ({
  instrumentApiResponse: vi.fn(),
  reconstructApiRoute: vi.fn(),
}));

import { sessionCookieName } from '@civitai/auth';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { API_REQUESTS_METRIC, apiRequestsCounter } from '~/server/prom/api-requests.metrics';
import {
  API_CREDENTIAL_LABELS,
  apiCredentialLabel,
  PublicEndpoint,
} from '~/server/utils/endpoint-helpers';

const GOOD_KEY = 'good-key-7f3a';
const OTHER_KEY = 'other-key-91c2';
const BAD_KEY = 'bad-key-0d44';
const GOOD_COOKIE = 'good-cookie-5be1';
const COOKIE = sessionCookieName(true);

type Fixture = {
  url: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  method?: string;
};

function makeReq({ url, headers = {}, cookies = {}, method = 'GET' }: Fixture) {
  const query = Object.fromEntries(new URL(url, 'http://x').searchParams);
  return { method, url, headers, cookies, query } as unknown as NextApiRequest;
}

function makeRes() {
  const emitter = new EventEmitter();
  const headers: Record<string, unknown> = {};
  const res = Object.assign(emitter, {
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json() {
      res.headersSent = true;
      emitter.emit('finish');
      return res;
    },
    end() {
      res.headersSent = true;
      emitter.emit('finish');
      return res;
    },
  });
  return res as unknown as NextApiResponse;
}

async function labelAfterAuth(fixture: Fixture) {
  const req = makeReq(fixture);
  await getServerAuthSession({ req, res: makeRes() });
  return apiCredentialLabel(req);
}

beforeEach(() => {
  getSessionFromBearerToken.mockReset();
  getSessionFromBearerToken.mockImplementation(async (token: string) =>
    token === GOOD_KEY || token === OTHER_KEY
      ? {
          user: { id: 701 },
          apiKeyId: 44,
          apiKeyType: 'User',
          subject: { type: 'apiKey', id: 44 },
          tokenScope: 3,
          buzzLimit: null,
        }
      : null
  );
  getHubSession.mockReset();
  getHubSession.mockImplementation(async (req: NextApiRequest) =>
    req.cookies?.[COOKIE] === GOOD_COOKIE ? { user: { id: 702 } } : null
  );
  apiRequestsCounter.reset();
});

const PRIMARY_CASES: [string, Fixture, string][] = [
  ['no credential', { url: '/api/v1/models' }, 'anonymous'],
  [
    'an API key in the Authorization header',
    { url: '/api/v1/models', headers: { authorization: `Bearer ${GOOD_KEY}` } },
    'key_header',
  ],
  ['an API key in ?token=', { url: `/api/v1/models?token=${GOOD_KEY}` }, 'key_param'],
  ['a session cookie', { url: '/api/v1/models', cookies: { [COOKIE]: GOOD_COOKIE } }, 'cookie'],
];

describe('apiCredentialLabel after the real getServerAuthSession', () => {
  it.each(PRIMARY_CASES)('labels %s', async (_name, fixture, expected) => {
    expect(await labelAfterAuth(fixture)).toBe(expected);
  });

  it('gives the four credential types four different labels', async () => {
    const labels = await Promise.all(PRIMARY_CASES.map(([, f]) => labelAfterAuth(f)));
    expect(new Set(labels).size).toBe(4);
  });

  it('names the header when both carriers are present (auth reads it first)', async () => {
    const req = makeReq({
      url: `/api/v1/models?token=${OTHER_KEY}`,
      headers: { authorization: `Bearer ${GOOD_KEY}` },
    });
    await getServerAuthSession({ req, res: makeRes() });
    expect(getSessionFromBearerToken).toHaveBeenCalledWith(GOOD_KEY);
    expect(apiCredentialLabel(req)).toBe('key_header');
  });

  it('labels a presented key that does not resolve as unverified', async () => {
    expect(
      await labelAfterAuth({
        url: '/api/v1/models',
        headers: { authorization: `Bearer ${BAD_KEY}` },
      })
    ).toBe('unverified');
    expect(await labelAfterAuth({ url: `/api/v1/models?token=${BAD_KEY}` })).toBe('unverified');
    expect(
      await labelAfterAuth({ url: '/api/v1/models', cookies: { [COOKIE]: 'expired-cookie' } })
    ).toBe('unverified');
  });

  it('labels a valid key on a route that never authenticates as unverified', () => {
    const req = makeReq({ url: '/api/v1/tags', headers: { authorization: `Bearer ${GOOD_KEY}` } });
    expect(apiCredentialLabel(req)).toBe('unverified');
  });

  it('only ever returns a value from the declared label set', async () => {
    const all = [
      ...PRIMARY_CASES.map(([, f]) => f),
      { url: '/api/v1/models', headers: { authorization: `Bearer ${BAD_KEY}` } },
    ];
    for (const f of all) expect(API_CREDENTIAL_LABELS).toContain(await labelAfterAuth(f));
  });
});

async function counterValues() {
  const metric = await apiRequestsCounter.get();
  expect(metric.name).toBe(API_REQUESTS_METRIC);
  return metric.values.map((v) => ({ ...v.labels, value: v.value }));
}

describe('civitai_app_api_requests_total via the endpoint wrappers', () => {
  // A handler that authenticates, as `v1/images` and the MixedAuth routes do.
  const authenticating = PublicEndpoint(async (req, res) => {
    await getServerAuthSession({ req, res });
    res.status(200).json({ ok: true });
  });

  it.each(PRIMARY_CASES)(
    'counts a v1 response served for %s under that label',
    async (_n, fixture, expected) => {
      await authenticating(makeReq(fixture), makeRes());
      expect(await counterValues()).toEqual([{ surface: 'v1', credential: expected, value: 1 }]);
    }
  );

  it('labels a non-v1 route surface=other', async () => {
    await authenticating(
      makeReq({ url: '/api/user/settings', cookies: { [COOKIE]: GOOD_COOKIE } }),
      makeRes()
    );
    expect(await counterValues()).toEqual([{ surface: 'other', credential: 'cookie', value: 1 }]);
  });

  it('does not count an OPTIONS preflight', async () => {
    await authenticating(makeReq({ url: '/api/v1/models', method: 'OPTIONS' }), makeRes());
    expect(await counterValues()).toEqual([]);
  });

  it('records nothing until the response finishes', async () => {
    const never = PublicEndpoint(async () => undefined);
    await never(makeReq({ url: '/api/v1/models' }), makeRes());
    expect(await counterValues()).toEqual([]);
  });
});
