import { beforeEach, describe, expect, it, vi } from 'vitest';
// RSA env for the (real) middleware's block-token.service module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';

/**
 * The three `/api/v1/blocks/sub-listings/*` handlers: the parent app always comes from the
 * verified token, never the body, and service refusals keep their status and code.
 */

const { mockUpsert, mockWithdraw, mockMine, mockGetSessionUser } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockWithdraw: vi.fn(),
  mockMine: vi.fn(),
  mockGetSessionUser: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (id: number) => mockGetSessionUser(id) },
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  upsertSubListing: mockUpsert,
  withdrawSubListing: mockWithdraw,
  listMySubListings: mockMine,
}));

import { baseHandler as upsertHandler } from '~/pages/api/v1/blocks/sub-listings/upsert';
import { baseHandler as withdrawHandler } from '~/pages/api/v1/blocks/sub-listings/withdraw';
import { baseHandler as mineHandler } from '~/pages/api/v1/blocks/sub-listings/mine';
import { SubListingError } from '~/server/services/blocks/app-sub-listing.service';

const VIEWER = 42;
const APP_BLOCK_ID = 'apb_TOKEN';

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

function makeReq(method: string, body?: unknown, sub = `user:${VIEWER}`): NextApiRequest {
  return {
    method,
    headers: {},
    query: {},
    body,
    blockClaims: { sub, appBlockId: APP_BLOCK_ID, blockInstanceId: 'bki_1' },
  } as unknown as NextApiRequest;
}

const call = async (
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  req: NextApiRequest
) => {
  const res = makeRes();
  await handler(req, res);
  return res;
};

beforeEach(() => {
  for (const m of [mockUpsert, mockWithdraw, mockMine, mockGetSessionUser]) m.mockReset();
  mockGetSessionUser.mockResolvedValue({ id: VIEWER, emailVerified: new Date() });
  dbMock.dbRead.account.count.mockResolvedValue(0);
});

describe('POST sub-listings/upsert', () => {
  it('passes the TOKEN’s app and the resolved subject; a body appBlockId is just body', async () => {
    mockUpsert.mockResolvedValue({ id: 'asl_1', status: 'pending', pendingEdit: false });
    const body = { itemKey: 'k', title: 't', subPath: 'g/k', appBlockId: 'apb_OTHER' };
    const res = await call(upsertHandler, makeReq('POST', body));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'asl_1', status: 'pending', pendingEdit: false });
    expect(mockUpsert).toHaveBeenCalledWith({
      appBlockId: APP_BLOCK_ID,
      subjectUser: expect.objectContaining({ id: VIEWER }),
      hasLinkedOAuth: false,
      body,
    });
  });

  it('checks for a linked login only when the email is unverified', async () => {
    mockUpsert.mockResolvedValue({ id: 'asl_1', status: 'pending', pendingEdit: false });
    mockGetSessionUser.mockResolvedValueOnce({ id: VIEWER, emailVerified: null });
    dbMock.dbRead.account.count.mockResolvedValueOnce(1);
    await call(upsertHandler, makeReq('POST', {}));
    expect(mockUpsert.mock.calls[0][0].hasLinkedOAuth).toBe(true);
  });

  it('an anonymous token reaches the service with no subject (which refuses it)', async () => {
    mockUpsert.mockRejectedValue(new SubListingError(401, 'anonymous', 'Sign in'));
    const res = await call(upsertHandler, makeReq('POST', {}, 'anon'));
    expect(mockUpsert.mock.calls[0][0].subjectUser).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Sign in', code: 'anonymous' });
  });

  it('a vanished subject is refused before the service runs', async () => {
    mockGetSessionUser.mockResolvedValueOnce(null);
    const res = await call(upsertHandler, makeReq('POST', {}));
    expect(res.statusCode).toBe(403);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'not_enabled'],
    [404, 'item_not_found'],
    [503, 'unavailable'],
  ] as const)('keeps a %i %s refusal', async (status, code) => {
    mockUpsert.mockRejectedValue(new SubListingError(status, code, 'nope'));
    const res = await call(upsertHandler, makeReq('POST', {}));
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: 'nope', code });
  });

  it('a rate-limit refusal carries Retry-After', async () => {
    mockUpsert.mockRejectedValue(new SubListingError(429, 'rate_limited', 'slow', 33));
    const res = await call(upsertHandler, makeReq('POST', {}));
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('33');
  });

  it('an unexpected error is rethrown, not dressed as a refusal', async () => {
    mockUpsert.mockRejectedValue(new Error('boom'));
    await expect(call(upsertHandler, makeReq('POST', {}))).rejects.toThrow('boom');
  });

  it('only POST', async () => {
    const res = await call(upsertHandler, makeReq('GET'));
    expect(res.statusCode).toBe(405);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('POST sub-listings/withdraw and GET sub-listings/mine', () => {
  it('withdraw passes the token’s app and subject', async () => {
    mockWithdraw.mockResolvedValue({ ok: true, withdrawn: true });
    const res = await call(withdrawHandler, makeReq('POST', { itemKey: 'k' }));
    expect(res.body).toEqual({ ok: true, withdrawn: true });
    expect(mockWithdraw).toHaveBeenCalledWith({
      appBlockId: APP_BLOCK_ID,
      userId: VIEWER,
      body: { itemKey: 'k' },
    });
  });

  it('mine is scoped to the token’s app and subject', async () => {
    mockMine.mockResolvedValue({ items: [] });
    const res = await call(mineHandler, makeReq('GET'));
    expect(res.statusCode).toBe(200);
    expect(mockMine).toHaveBeenCalledWith({ appBlockId: APP_BLOCK_ID, userId: VIEWER });
  });

  it('mine answers 503 while the tables are absent', async () => {
    mockMine.mockRejectedValue(new SubListingError(503, 'unavailable', 'later'));
    const res = await call(mineHandler, makeReq('GET'));
    expect(res.statusCode).toBe(503);
  });
});
