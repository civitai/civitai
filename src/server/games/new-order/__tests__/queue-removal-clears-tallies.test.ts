import { describe, it, expect, vi, beforeEach } from 'vitest';

// Images taken out of the queues by the mod queue tool or by a moderator's rating lose their vote
// tallies too.

const { pool, mockClear, mockIsImageInQueue, mockLeaveQueues } = vi.hoisted(() => ({
  pool: { reset: vi.fn(), getAll: vi.fn() },
  mockClear: vi.fn(),
  mockIsImageInQueue: vi.fn(),
  mockLeaveQueues: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/games/new-order/utils', () => ({
  poolCounters: { Knight: { a: [pool], b: [pool] } },
  getActiveSlot: vi.fn(),
  clearImageRatings: mockClear,
}));
vi.mock('~/server/services/games/new-order.service', () => ({
  addImageToQueue: vi.fn(),
  isImageInQueue: mockIsImageInQueue,
  leaveQueuesAfterModeratorRating: mockLeaveQueues,
  updatePendingImageRatings: vi.fn(),
}));

import manageQueue from '~/pages/api/mod/new-order/manage-queue';
import konoFinalize from '~/pages/api/internal/kono-finalize';

const call = async (handler: unknown, req: object) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await (handler as (req: object, res: object) => Promise<unknown>)(req, res);
  return res.status.mock.calls[0]?.[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  pool.reset.mockResolvedValue(undefined);
});

describe('removing images from the queues clears their tallies', () => {
  it('manage-queue remove-from-queue', async () => {
    const status = await call(manageQueue, {
      query: { action: 'remove-from-queue', rankType: 'Knight', imageIds: '5,6' },
    });

    expect(status).toBe(200);
    expect(pool.reset).toHaveBeenCalledWith({ id: [5, 6] });
    expect(mockClear).toHaveBeenCalledWith([5, 6]);
  });

  it('kono-finalize leaves the queues through the moderator-rating cleanup', async () => {
    const status = await call(konoFinalize, { method: 'POST', body: { imageId: 9, nsfwLevel: 1 } });

    expect(status).toBe(200);
    expect(mockLeaveQueues).toHaveBeenCalledTimes(1);
    expect(mockLeaveQueues).toHaveBeenCalledWith(9);
  });

  it('kono-finalize control: an invalid request leaves the queues alone', async () => {
    const status = await call(konoFinalize, { method: 'POST', body: { imageId: -1 } });

    expect(status).toBe(400);
    expect(mockLeaveQueues).not.toHaveBeenCalled();
  });
});
