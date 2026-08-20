import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';

const { declinePlacementsOnBlock } = vi.hoisted(() => ({
  declinePlacementsOnBlock: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  declinePlacementsOnBlock,
}));

import { toggleHidden } from '~/server/services/user-preferences.service';

const userId = 42;
const targetUserId = 99;
const engagement = dbMock.dbWrite.userEngagement;

const block = (hidden?: boolean) =>
  toggleHidden({ kind: 'blockedUser', data: [{ id: targetUserId }], hidden, userId });

beforeEach(() => {
  vi.clearAllMocks();
  engagement.create.mockResolvedValue({});
  engagement.update.mockResolvedValue({});
  engagement.delete.mockResolvedValue({});
});

// The bug this pins: `toggleHidden` dropped `hidden` on the way to
// `toggleBlockUser`, so the service could only flip whatever it found. A client
// holding a stale block list therefore sent "block" and got an UNBLOCK, and the
// UI reported success either way. These assert through `toggleHidden` — the
// exported entry the router calls — because a test calling `toggleBlockUser`
// directly cannot see an argument the caller failed to pass.
describe('toggleHidden kind=blockedUser — honours the caller intent', () => {
  it('hidden=true on an ALREADY blocked user leaves the block in place', async () => {
    engagement.findUnique.mockResolvedValueOnce({ type: 'Block' });

    await block(true);

    expect(engagement.delete).not.toHaveBeenCalled();
    expect(engagement.create).not.toHaveBeenCalled();
    expect(engagement.update).not.toHaveBeenCalled();
  });

  it('hidden=false on a blocked user removes the block', async () => {
    engagement.findUnique.mockResolvedValueOnce({ type: 'Block' });

    await block(false);

    expect(engagement.delete).toHaveBeenCalledWith({
      where: { userId_targetUserId: { userId, targetUserId } },
    });
  });

  it('hidden=true with no engagement writes a Block row', async () => {
    engagement.findUnique.mockResolvedValueOnce(null);

    await block(true);

    expect(engagement.create).toHaveBeenCalledWith({
      data: { userId, targetUserId, type: 'Block' },
    });
  });

  it('hidden=false with no engagement writes nothing — an unblock must not create a block', async () => {
    engagement.findUnique.mockResolvedValueOnce(null);

    await block(false);

    expect(engagement.create).not.toHaveBeenCalled();
    expect(engagement.update).not.toHaveBeenCalled();
    expect(engagement.delete).not.toHaveBeenCalled();
  });

  it('hidden=true over an existing Follow promotes the row to Block', async () => {
    engagement.findUnique.mockResolvedValueOnce({ type: 'Follow' });

    await block(true);

    expect(engagement.update).toHaveBeenCalledWith({
      where: { userId_targetUserId: { userId, targetUserId } },
      data: { type: 'Block' },
    });
  });

  it('hidden omitted still flips, so callers that send no intent are unchanged', async () => {
    engagement.findUnique.mockResolvedValueOnce({ type: 'Block' });

    await block(undefined);

    expect(engagement.delete).toHaveBeenCalled();
  });
});

describe('toggleHidden kind=blockedUser — placement cascade', () => {
  it('runs when the block is newly established', async () => {
    engagement.findUnique.mockResolvedValueOnce(null);

    await block(true);

    expect(declinePlacementsOnBlock).toHaveBeenCalledWith({
      ownerId: userId,
      placerId: targetUserId,
      waiveFee: true,
    });
    expect(declinePlacementsOnBlock).toHaveBeenCalledWith({
      ownerId: targetUserId,
      placerId: userId,
      waiveFee: false,
    });
  });

  it('does not run on an unblock', async () => {
    engagement.findUnique.mockResolvedValueOnce({ type: 'Block' });

    await block(false);

    expect(declinePlacementsOnBlock).not.toHaveBeenCalled();
  });
});
