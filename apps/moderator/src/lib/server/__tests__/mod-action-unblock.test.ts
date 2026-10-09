import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOD_ACTION } from '@civitai/moderation';

/**
 * The main app's Unblock reaches the spoke's accept through this registry. Review queues refuse to
 * accept an image removed with only its review flag left; an explicit unblock is how such an image is
 * restored, so this path must opt past that refusal.
 */

const { acceptImage, blockImage } = vi.hoisted(() => ({
  acceptImage: vi.fn(async () => undefined),
  blockImage: vi.fn(async () => undefined),
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
