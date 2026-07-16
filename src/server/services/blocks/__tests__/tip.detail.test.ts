import { beforeEach, describe, expect, it, vi } from 'vitest';
// RSA env for the (real) middleware's block-token.service module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * W13 — the tip REST handler stashes a structured `BlockActionDetail` on the
 * response (the middleware finish-writer then records it). We drive the exported
 * baseHandler directly with a valid claims-bearing request + a resolving tip
 * flow, and assert the stashed detail via the REAL readBlockActionDetail.
 */

const {
  mockCreateTip,
  mockUserFindUnique,
  mockHydrateSubject,
  mockCheckRateLimit,
  mockReserve,
  mockRefund,
} = vi.hoisted(() => ({
  mockCreateTip: vi.fn(async () => undefined),
  mockUserFindUnique: vi.fn(async () => ({ id: 7, deletedAt: null })),
  mockHydrateSubject: vi.fn(async () => ({ id: 42, bannedAt: null, muted: false })),
  mockCheckRateLimit: vi.fn(async () => ({ allowed: true })),
  mockReserve: vi.fn(async () => ({ total: 500, key: 'tipcap:42' })),
  mockRefund: vi.fn(async () => undefined),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/controllers/buzz.controller', () => ({
  createBuzzTipTransactionHandler: mockCreateTip,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { user: { findUnique: mockUserFindUnique } },
}));
vi.mock('~/server/clickhouse/client', () => ({ Tracker: class {} }));
vi.mock('~/server/services/blocks/block-collections.service', () => ({
  hydrateBlockSubject: mockHydrateSubject,
}));
vi.mock('~/server/utils/block-tip-rate-limit', () => ({
  BLOCK_TIP_CAP_PER_DAY: 25_000,
  BLOCK_TIP_MAX_PER_TIP: 5_000,
  checkBlockTipRateLimit: mockCheckRateLimit,
  refundBlockTipSpend: mockRefund,
  reserveBlockTipSpend: mockReserve,
}));

import { baseHandler } from '../tip';
import { readBlockActionDetail } from '~/server/middleware/block-scope.middleware';

function makeRes(): NextApiResponse & { body?: unknown } {
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as NextApiResponse & { body?: unknown };
}

function makeReq(body: Record<string, unknown>): NextApiRequest {
  return {
    method: 'POST',
    headers: {},
    body,
    blockClaims: { sub: 'user:42', blockInstanceId: 'bki_1' },
  } as unknown as NextApiRequest;
}

describe('tip handler — W13 action detail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stashes a tip detail with amount, recipient, and entity refs on success', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq({ toUserId: 7, amount: 500, entityType: 'Image', entityId: 9 }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(readBlockActionDetail(res)).toEqual({
      action: 'tip',
      amount: 500,
      toUserId: 7,
      entityType: 'Image',
      entityId: 9,
      outcome: 'ok',
    });
  });

  it('omits entity refs when the tip carries none', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ toUserId: 7, amount: 250 }), res);
    expect(readBlockActionDetail(res)).toEqual({
      action: 'tip',
      amount: 250,
      toUserId: 7,
      outcome: 'ok',
    });
  });

  it('stashes NOTHING when the tip fails (money path throws)', async () => {
    mockCreateTip.mockRejectedValueOnce(
      Object.assign(new Error('insufficient funds'), { code: 'BAD_REQUEST' })
    );
    const res = makeRes();
    await baseHandler(makeReq({ toUserId: 7, amount: 500 }), res);
    expect(readBlockActionDetail(res)).toBeUndefined();
  });
});
