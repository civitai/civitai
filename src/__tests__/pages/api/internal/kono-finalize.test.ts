import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settle: vi.fn(),
  leaveQueues: vi.fn(),
  v1Live: vi.fn(async () => false),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
// Retired on purpose: a gate added to the handler would skip the settlement below and fail this test.
vi.mock('~/server/games/new-order/v1-gate', () => ({ isV1KnightsLive: mocks.v1Live }));
vi.mock('~/server/services/games/new-order.service', () => ({
  updatePendingImageRatings: mocks.settle,
  leaveQueuesAfterModeratorRating: mocks.leaveQueues,
}));

import handler from '~/pages/api/internal/kono-finalize';

describe('kono-finalize', () => {
  it('settles pending votes and leaves the queues even after v1 is retired', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };

    await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      { method: 'POST', body: { imageId: 5, nsfwLevel: 4 } } as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(mocks.settle).toHaveBeenCalledWith({ imageId: 5, rating: 4 });
    expect(mocks.leaveQueues).toHaveBeenCalledWith(5);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
