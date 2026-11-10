import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settle: vi.fn(),
  leaveQueues: vi.fn(),
  v1Live: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/games/new-order/v1-gate', () => ({ isV1KnightsLive: mocks.v1Live }));
vi.mock('~/server/services/games/new-order.service', () => ({
  updatePendingImageRatings: mocks.settle,
  leaveQueuesAfterModeratorRating: mocks.leaveQueues,
}));

import handler from '~/pages/api/internal/kono-finalize';

const post = async () => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', body: { imageId: 5, nsfwLevel: 4 } } as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.v1Live.mockReturnValue(true);
});

describe('kono-finalize', () => {
  it('settles the votes and leaves the queues while the v1 game is live', async () => {
    const res = await post();

    expect(mocks.settle).toHaveBeenCalledWith({ imageId: 5, rating: 4 });
    expect(mocks.leaveQueues).toHaveBeenCalledWith(5);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('answers ok but does nothing once the v1 game is retired', async () => {
    mocks.v1Live.mockReturnValue(false);

    const res = await post();

    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.leaveQueues).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
