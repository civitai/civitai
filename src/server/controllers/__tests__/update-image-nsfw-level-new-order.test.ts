import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import type * as NewOrderService from '~/server/services/games/new-order.service';
import '~/__tests__/mocks/db.mock';

// A moderator's NSFW rating settles the image's New Order votes and takes it out of the queues;
// a member's vote does neither.

const { updateLevel, raiseOwn, settle, leaveQueues } = vi.hoisted(() => ({
  updateLevel: vi.fn(),
  raiseOwn: vi.fn(),
  settle: vi.fn(),
  leaveQueues: vi.fn(),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  updateImageNsfwLevel: updateLevel,
  raiseOwnImageNsfwLevel: raiseOwn,
}));
vi.mock('~/server/services/games/new-order.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderService>()),
  updatePendingImageRatings: settle,
  leaveQueuesAfterModeratorRating: leaveQueues,
}));

const { handleUpdateImageNsfwLevel } = await import('~/server/controllers/image.controller');
type Args = Parameters<typeof handleUpdateImageNsfwLevel>[0];

const rate = (isModerator: boolean) =>
  handleUpdateImageNsfwLevel({
    input: { id: 9, nsfwLevel: 8 } as Args['input'],
    ctx: { user: { id: 1, isModerator } } as unknown as Args['ctx'],
  });

beforeEach(() => {
  vi.clearAllMocks();
  updateLevel.mockResolvedValue(8);
  raiseOwn.mockResolvedValue(false);
  settle.mockResolvedValue(undefined);
  leaveQueues.mockResolvedValue(undefined);
});

describe('handleUpdateImageNsfwLevel and New Order', () => {
  it('a moderator rating settles the votes and takes the image out of the queues', async () => {
    expect(await rate(true)).toEqual({ nsfwLevel: 8, applied: true });

    expect(settle).toHaveBeenCalledWith({ imageId: 9, rating: 8 });
    expect(leaveQueues).toHaveBeenCalledWith(9);
  });

  it('control: a member vote leaves New Order alone', async () => {
    await rate(false);

    expect(settle).not.toHaveBeenCalled();
    expect(leaveQueues).not.toHaveBeenCalled();
  });
});
