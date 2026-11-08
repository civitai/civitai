import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GiftEndpointModule from '~/server/utils/model-gift-endpoint';

/** The claimer lists of one gift link and of one batch. */

const { listGiftClaims } = vi.hoisted(() => ({
  listGiftClaims: vi.fn(async () => ({ claims: [], nextCursor: null })),
}));
vi.mock('~/server/services/model-version-gift.service', () => ({ listGiftClaims }));
vi.mock('~/server/utils/model-gift-endpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof GiftEndpointModule>()),
  GiftEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, { id: 7, isModerator: false }),
}));

import linkClaims from '~/pages/api/v1/model-versions/[id]/gifts/[giftId]/claims';
import batchClaims from '~/pages/api/v1/model-versions/[id]/gifts/batch/[batchId]/claims';

async function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  query: Record<string, string>
) {
  const res = { statusCode: 0 } as { statusCode: number } & Record<string, unknown>;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = () => res;
  await handler(
    { method: 'GET', query } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res.statusCode;
}

const BATCH = '00000000-0000-4000-8000-000000000001';

beforeEach(() => listGiftClaims.mockClear());

describe('gift claimer lists', () => {
  it("asks for one link's claimers as the session user", async () => {
    expect(await call(linkClaims, { id: '5', giftId: '9', userId: '99' })).toBe(200);
    expect(listGiftClaims).toHaveBeenCalledWith({
      userId: 7,
      isModerator: false,
      modelVersionId: 5,
      id: 9,
      limit: 100,
    });
  });

  it("asks for one batch's claimers, with the cursor", async () => {
    expect(await call(batchClaims, { id: '5', batchId: BATCH, cursor: 'c', userId: '99' })).toBe(
      200
    );
    expect(listGiftClaims).toHaveBeenCalledTimes(1);
    expect(listGiftClaims).toHaveBeenCalledWith({
      userId: 7,
      isModerator: false,
      modelVersionId: 5,
      batchId: BATCH,
      cursor: 'c',
      limit: 100,
    });
  });

  it('refuses a bad id, a bad batch or an oversized page, without a lookup', async () => {
    expect(await call(linkClaims, { id: '5', giftId: 'x' })).toBe(400);
    expect(await call(batchClaims, { id: '5', batchId: 'nope' })).toBe(400);
    expect(await call(linkClaims, { id: '5', giftId: '9', limit: '101' })).toBe(400);
    expect(listGiftClaims).not.toHaveBeenCalled();
  });
});
