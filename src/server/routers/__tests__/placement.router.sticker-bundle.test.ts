import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getStickerPlacementsAndCounts` is the only source of placements for a signed-in viewer, so the
 * viewer it is asked about must be the SESSION's. Dropped, a placer stops seeing their own pending
 * sticker on every surface; a moderator's listing loses the kept-off rows they need to act on. The
 * service tests pass both values directly, so only this boundary can see them go missing.
 */

import type * as StickerPlacementService from '~/server/services/sticker-placement.service';

const { getStickerPlacementsAndCounts } = vi.hoisted(() => ({
  getStickerPlacementsAndCounts: vi.fn(async () => ({ placements: [], counts: {} })),
}));

vi.mock('~/server/services/sticker-placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerPlacementService>()),
  getStickerPlacementsAndCounts,
}));

import { PLACER, placementCaller } from '~/server/routers/__tests__/placement.router.test-utils';

const MODERATOR = 913;

beforeEach(() => vi.clearAllMocks());

describe('placement router — the combined sticker call', () => {
  it("asks about the session's viewer, not anyone the input names", async () => {
    await placementCaller().getStickerPlacementsAndCounts({
      imageIds: [11, 12],
      viewerId: 999,
    } as never);

    expect(getStickerPlacementsAndCounts).toHaveBeenCalledWith({
      imageIds: [11, 12],
      viewerId: PLACER,
      isModerator: false,
    });
  });

  it("carries a moderator's standing through", async () => {
    await placementCaller({
      user: { id: MODERATOR, isModerator: true },
    }).getStickerPlacementsAndCounts({ imageIds: [11] });

    expect(getStickerPlacementsAndCounts).toHaveBeenCalledWith({
      imageIds: [11],
      viewerId: MODERATOR,
      isModerator: true,
    });
  });

  it('refuses more ids than one chunk', async () => {
    const imageIds = Array.from({ length: 101 }, (_, index) => index + 1);

    await expect(placementCaller().getStickerPlacementsAndCounts({ imageIds })).rejects.toThrow();
    expect(getStickerPlacementsAndCounts).not.toHaveBeenCalled();
  });
});
