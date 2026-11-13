import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOD_ACTION } from '@civitai/moderation';

/**
 * The main app's Unblock reaches the spoke's accept through this registry. Review queues refuse to
 * accept an image removed with only its review flag left; an explicit unblock is how such an image is
 * restored, so this path must opt past that refusal.
 */

const { acceptImage, blockImage } = vi.hoisted(() => ({
  acceptImage: vi.fn(async () => undefined),
  blockImage: vi.fn(async (): Promise<{ held?: unknown }> => ({})),
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../image-moderation.service', () => ({ acceptImage, blockImage }));

const { modActions } = await import('../mod-actions/registry');

beforeEach(() => {
  acceptImage.mockClear();
  blockImage.mockClear();
});

describe('imageModerate', () => {
  it('unblocks as an explicit restore', async () => {
    await modActions[MOD_ACTION.imageModerate].handler({
      ids: [52],
      reviewAction: 'unblock',
      userId: 2,
    });

    expect(acceptImage).toHaveBeenCalledWith({ imageId: 52, userId: 2, restoreRemoved: true });
  });
});

// The main app's Reject on an image approved on appeal: a same-reason removal is held, and the main
// app must hear why the image is still up.
describe('imageModerate block', () => {
  const held = {
    imageId: 52,
    confirmationId: 1,
    created: true,
    appeal: { approvedAt: new Date('2026-10-14T16:59:45Z'), approvedByUsername: 'appr' },
  };

  it('answers 409 with the reason when the removal is held', async () => {
    blockImage.mockResolvedValueOnce({ held });

    const run = modActions[MOD_ACTION.imageModerate].handler({
      ids: [52],
      reviewAction: 'block',
      userId: 2,
    });

    await expect(run).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('second moderator must confirm'),
    });
  });

  it("passes the caller's confirm permission through as the skip", async () => {
    await modActions[MOD_ACTION.imageModerate].handler({
      ids: [52],
      reviewAction: 'block',
      userId: 2,
      canConfirmReRemoval: true,
    });

    expect(blockImage).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 52, userId: 2, skipAppealCheck: true })
    );
  });
});
