import { beforeEach, describe, expect, it, vi } from 'vitest';
// RSA env for the (real) middleware's block-token.service module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

import type * as BlockGoodsService from '~/server/services/blocks/block-goods.service';
import type * as GoodsRateLimit from '~/server/utils/block-goods-rate-limit';

/**
 * `GET /api/v1/blocks/entitlements` — the viewer's owned goods, for the CALLING
 * app only.
 *
 * Behaviour specs for new code; the app-scoping assertions are invariant guards
 * on the property that matters (an app cannot read another app's sales).
 */

const { mockList, mockRateLimit } = vi.hoisted(() => ({
  mockList: vi.fn(async () => [] as unknown[]),
  mockRateLimit: vi.fn<
    (
      blockInstanceId: string,
      userId: number
    ) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>
  >(async () => ({ allowed: true })),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

vi.mock('~/server/services/blocks/block-goods.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockGoodsService>()),
  listBlockGoodEntitlements: mockList,
}));

vi.mock('~/server/utils/block-goods-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof GoodsRateLimit>()),
  checkBlockGoodReadRateLimit: mockRateLimit,
}));

import { baseHandler } from '~/pages/api/v1/blocks/entitlements';

const VIEWER = 42;
const APP_BLOCK_ID = 'apb_TESTBLOCK';

const ENTITLEMENT = {
  goodId: 'extra-slots',
  kind: 'good',
  payload: { slots: 5 },
  grantedAt: '2026-09-27T00:00:00.000Z',
};

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

function makeReq(
  claims: Record<string, unknown> | null = {
    sub: `user:${VIEWER}`,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_1',
  },
  method = 'GET'
): NextApiRequest {
  return {
    method,
    headers: {},
    query: {},
    ...(claims ? { blockClaims: claims } : {}),
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true } as never);
  mockList.mockResolvedValue([ENTITLEMENT] as never);
});

describe('GET /api/v1/blocks/entitlements', () => {
  it('returns the viewer’s entitlements for the CALLING app', async () => {
    const res = makeRes();
    await baseHandler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ entitlements: [ENTITLEMENT] });
    // 🔴 Both arguments come from the verified token. Neither is readable from
    // the request, so there is no shape of call that widens the answer.
    expect(mockList).toHaveBeenCalledWith({ userId: VIEWER, appBlockId: APP_BLOCK_ID });
  });

  it('asks for a DIFFERENT app when a different app’s token calls', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq({ sub: `user:${VIEWER}`, appBlockId: 'apb_OTHERAPP', blockInstanceId: 'bki_2' }),
      res
    );
    expect(mockList).toHaveBeenCalledWith({ userId: VIEWER, appBlockId: 'apb_OTHERAPP' });
  });

  it('asks for a DIFFERENT viewer when a different subject calls', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq({ sub: 'user:9001', appBlockId: APP_BLOCK_ID, blockInstanceId: 'bki_1' }),
      res
    );
    expect(mockList).toHaveBeenCalledWith({ userId: 9001, appBlockId: APP_BLOCK_ID });
  });

  it('returns an empty list rather than 404 when the viewer owns nothing', async () => {
    mockList.mockResolvedValueOnce([] as never);
    const res = makeRes();
    await baseHandler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ entitlements: [] });
  });

  it('405s a non-GET', async () => {
    const res = makeRes();
    await baseHandler(makeReq(undefined, 'POST'), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('401s with no block claims', async () => {
    const res = makeRes();
    await baseHandler(makeReq(null), res);
    expect(res.statusCode).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('403s an ANONYMOUS token — it holds no entitlements', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq({ sub: 'anon', appBlockId: APP_BLOCK_ID, blockInstanceId: 'x' }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('403s a MALFORMED subject claim', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq({ sub: 'user:not-a-number', appBlockId: APP_BLOCK_ID, blockInstanceId: 'x' }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('rate-limits on (instance, VIEWER) — NOT on the instance alone', async () => {
    // 🔴 The second key segment is the whole point. The shared catalog bucket keys
    // on `blockInstanceId` alone, and for a PAGE app that is the synthetic
    // `page_<appBlockId>` shared by every concurrent viewer platform-wide — so a
    // mount read would be refused because of strangers' traffic, and a refused
    // entitlements read renders as "you own nothing".
    const res = makeRes();
    await baseHandler(makeReq(), res);
    expect(mockRateLimit).toHaveBeenCalledWith('bki_1', VIEWER);
  });

  it('429s with Retry-After when its own bucket refuses', async () => {
    mockRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 4 } as never);
    const res = makeRes();
    await baseHandler(makeReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('4');
    expect(mockList).not.toHaveBeenCalled();
  });
});
