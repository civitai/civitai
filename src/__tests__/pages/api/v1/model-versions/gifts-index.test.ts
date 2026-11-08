import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** `GET /api/v1/model-versions/gifts`: the caller's own gift index, one capped page at a time. */

const { listMyGiftLinks } = vi.hoisted(() => ({
  listMyGiftLinks: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('~/server/services/model-version-gift.service', () => ({ listMyGiftLinks }));
vi.mock('~/server/utils/model-gift-endpoint', () => ({
  GiftEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, { id: 7, isModerator: true }),
}));

import handler from '~/pages/api/v1/model-versions/gifts';

function call(query: Record<string, string>) {
  const res = { statusCode: 0, body: undefined as unknown } as {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return Promise.resolve(
    handler(
      { method: 'GET', query } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    )
  ).then(() => res);
}

beforeEach(() => listMyGiftLinks.mockClear());

describe('GET /api/v1/model-versions/gifts', () => {
  it("lists the session user's gifts, whatever user the query names", async () => {
    const res = await call({ userId: '99', cursor: 'abc' });
    expect(res.statusCode).toBe(200);
    expect(listMyGiftLinks).toHaveBeenCalledWith({
      userId: 7,
      limit: 100,
      cursor: 'abc',
      fresh: false,
    });
  });

  it('reads the primary only when asked to', async () => {
    await call({ fresh: '1' });
    expect(listMyGiftLinks).toHaveBeenCalledWith(expect.objectContaining({ fresh: true }));
  });

  it('refuses a page larger than the cap', async () => {
    const res = await call({ limit: '101' });
    expect(res.statusCode).toBe(400);
    expect(listMyGiftLinks).not.toHaveBeenCalled();
  });
});
