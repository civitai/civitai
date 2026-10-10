import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Who may call `/api/v1/catalog/items*`: an OAuth client acting as itself, bound to the one
 * off-site listing linked to it. Then the two route modules on top of it.
 */

const { mockSession, mockUpsert, mockWithdraw, mockList } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockUpsert: vi.fn(),
  mockWithdraw: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: (key: string) => mockSession(key),
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  upsertCatalogSubListing: mockUpsert,
  withdrawCatalogSubListing: mockWithdraw,
  listCatalogSubListings: mockList,
}));

const { resolveCatalogCaller } = await import(
  '~/server/services/blocks/app-sub-listing-catalog-auth'
);
const { SubListingError } = await import('~/server/services/blocks/app-sub-listing.service');
const { baseHandler: itemHandler } = await import('~/pages/api/v1/catalog/items/[externalId]');
const { baseHandler: listHandler } = await import('~/pages/api/v1/catalog/items/index');

const OWNER = 1;
const CLIENT = 'client-games';
const PARENT = 'apl_GAMES';
const CATALOG = TokenScope.UserRead | TokenScope.AppStoreCatalogWrite;
const TOKEN = 'civitai_abc';

function session(over: Record<string, unknown> = {}) {
  return {
    user: { id: OWNER, isModerator: true },
    apiKeyId: 5,
    apiKeyType: 'Access',
    subject: { type: 'oauth', id: CLIENT },
    tokenScope: CATALOG,
    ...over,
  };
}

function req(over: Record<string, unknown> = {}): NextApiRequest {
  return {
    method: 'GET',
    url: '/api/v1/catalog/items',
    headers: { authorization: `Bearer ${TOKEN}` },
    query: {},
    ...over,
  } as unknown as NextApiRequest;
}

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(SubListingError);
  expect(err).toMatchObject({ status, code });
}

beforeEach(() => {
  resetSharedMocks();
  for (const m of [mockSession, mockUpsert, mockWithdraw, mockList]) m.mockReset();
  mockSession.mockResolvedValue(session());
  dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({
    userId: OWNER,
    grants: ['authorization_code', 'refresh_token', 'client_credentials'],
  });
  dbMock.dbRead.appListing.findMany.mockResolvedValue([{ id: PARENT }]);
});

describe('resolveCatalogCaller', () => {
  it('binds a client_credentials catalog token to its client’s one off-site listing', async () => {
    await expect(resolveCatalogCaller(req())).resolves.toEqual({
      clientId: CLIENT,
      parentListingId: PARENT,
    });
    expect(mockSession).toHaveBeenCalledWith(TOKEN);
    expect(dbMock.dbRead.appListing.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        connectClientId: CLIENT,
        kind: 'offsite',
        revisionOfId: null,
        status: 'approved',
        subListingParent: { is: { enabled: true, linkTemplate: { not: null } } },
      },
      take: 2,
    });
  });

  it.each([
    ['no Authorization header', { headers: {} }],
    ['a non-bearer header', { headers: { authorization: `Basic ${TOKEN}` } }],
    ['only a cookie', { headers: { cookie: `civ-token=${TOKEN}` } }],
    ['a ?token= query', { query: { token: TOKEN } }],
    ['a ?token= in the url', { url: `/api/v1/catalog/items?token=${TOKEN}` }],
  ])('401 for %s', async (_label, over) => {
    await expectError(resolveCatalogCaller(req(over)), 401, 'invalid_token');
  });

  it.each([
    ['an unknown or expired token', null],
    ['a personal API key', session({ apiKeyType: 'User', subject: { type: 'apiKey', id: 5 } })],
    ['a refresh token used as a bearer', session({ apiKeyType: 'Refresh' })],
    ['an access token without a client', session({ subject: { type: 'apiKey', id: 5 } })],
  ])('401 for %s', async (_label, value) => {
    mockSession.mockResolvedValueOnce(value);
    await expectError(resolveCatalogCaller(req()), 401, 'invalid_token');
    expect(dbMock.dbRead.appListing.findMany).not.toHaveBeenCalled();
  });

  it('403 for a token without the AppStoreCatalogWrite bit, even a Full one', async () => {
    mockSession.mockResolvedValueOnce(session({ tokenScope: TokenScope.Full }));
    await expectError(resolveCatalogCaller(req()), 403, 'insufficient_scope');
    expect(dbMock.dbRead.appListing.findMany).not.toHaveBeenCalled();
  });

  it('403 when the token was not issued to the client’s owner', async () => {
    mockSession.mockResolvedValueOnce(session({ user: { id: 99 } }));
    await expectError(resolveCatalogCaller(req()), 403, 'insufficient_scope');
  });

  it('403 when the client does not hold the client_credentials grant', async () => {
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValueOnce({
      userId: OWNER,
      grants: ['authorization_code', 'refresh_token'],
    });
    await expectError(resolveCatalogCaller(req()), 403, 'insufficient_scope');
  });

  it('403 not_enabled when no off-site listing is enabled for the client', async () => {
    dbMock.dbRead.appListing.findMany.mockResolvedValueOnce([]);
    await expectError(resolveCatalogCaller(req()), 403, 'not_enabled');
  });

  it('409 parent_ambiguous when more than one is', async () => {
    dbMock.dbRead.appListing.findMany.mockResolvedValueOnce([{ id: PARENT }, { id: 'apl_2' }]);
    await expectError(resolveCatalogCaller(req()), 409, 'parent_ambiguous');
  });

  it('503 before the link_template column is applied', async () => {
    dbMock.dbRead.appListing.findMany.mockRejectedValueOnce(
      Object.assign(new Error('column does not exist'), { code: 'P2022' })
    );
    await expectError(resolveCatalogCaller(req()), 503, 'unavailable');
  });
});

type TestRes = NextApiResponse & {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
};

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = String(value);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as TestRes;
}

async function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  over: Record<string, unknown>
) {
  const res = makeRes();
  await handler(req(over), res);
  return res;
}

describe('catalog item routes', () => {
  it('PUT publishes under the caller’s parent, with the path id and body', async () => {
    mockUpsert.mockResolvedValueOnce({ id: 'asl_1', status: 'pending' });
    const res = await call(itemHandler, {
      method: 'PUT',
      query: { externalId: 'neon-drift', parentListingId: 'apl_OTHER' },
      body: { title: 'Neon Drift' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith({
      parentListingId: PARENT,
      clientId: CLIENT,
      externalId: 'neon-drift',
      body: { title: 'Neon Drift' },
    });
  });

  it('DELETE withdraws under the caller’s parent', async () => {
    mockWithdraw.mockResolvedValueOnce({ ok: true, withdrawn: true });
    const res = await call(itemHandler, { method: 'DELETE', query: { externalId: 'neon-drift' } });
    expect(res.body).toEqual({ ok: true, withdrawn: true });
    expect(mockWithdraw).toHaveBeenCalledWith({
      parentListingId: PARENT,
      externalId: 'neon-drift',
    });
  });

  it('GET lists the caller’s parent with the cursor', async () => {
    mockList.mockResolvedValueOnce({ items: [], nextCursor: null });
    await call(listHandler, { query: { cursor: 'asl_x' } });
    expect(mockList).toHaveBeenCalledWith({ parentListingId: PARENT, cursor: 'asl_x' });
  });

  it('an unauthenticated call reaches no service function', async () => {
    const res = await call(itemHandler, { method: 'PUT', headers: {}, query: { externalId: 'x' } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'invalid_token' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('a service refusal keeps its status, code and Retry-After', async () => {
    mockUpsert.mockRejectedValueOnce(
      new SubListingError(429, 'rate_limited', 'Too many store item updates, retry later', 30)
    );
    const res = await call(itemHandler, { method: 'PUT', query: { externalId: 'x' }, body: {} });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('30');
    expect(res.body).toEqual({
      error: 'Too many store item updates, retry later',
      code: 'rate_limited',
    });
  });

  it.each([
    [itemHandler, 'GET', 'PUT, DELETE'],
    [listHandler, 'POST', 'GET'],
  ] as const)('405 for a method the route does not serve', async (handler, method, allow) => {
    const res = await call(handler, { method });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe(allow);
    expect(mockSession).not.toHaveBeenCalled();
  });

  it('an unexpected error is rethrown, not mapped', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('boom'));
    await expect(
      call(itemHandler, { method: 'PUT', query: { externalId: 'x' }, body: {} })
    ).rejects.toThrow('boom');
  });
});
