import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemixGalleryService from '~/server/services/remix-gallery.service';
import type * as StickerPlacementService from '~/server/services/sticker-placement.service';

/**
 * `getImageCardSummaries` stands in for three procedures on clients with `placementCardFold`, so
 * each half must answer exactly what its own procedure answers for the same ids and the same
 * session. The service fakes derive every value from the ids AND from the arguments they were
 * handed (viewer, moderator standing, level, storylines viewer), and per-id values are pairwise
 * distinct, so a half that asks about a different viewer or level — or lands on the wrong id —
 * returns a different value instead of colliding with the right one.
 */

type BundleArgs = { imageIds: number[]; viewerId?: number; isModerator?: boolean };
type RemixArgs = {
  imageIds: number[];
  browsingLevel: number;
  storylinesFor?: { viewer: { id: number; isModerator?: boolean } | null };
};

const services = vi.hoisted(() => ({
  getStickerPlacementsAndCounts: vi.fn(async ({ imageIds, viewerId, isModerator }: BundleArgs) => ({
    placements: imageIds.map((imageId) => ({
      id: imageId * 10 + (viewerId ?? 0),
      imageId,
      keptOff: isModerator ? true : undefined,
    })),
    counts: Object.fromEntries(imageIds.map((id) => [id, (id % 7) + 2 + (viewerId ?? 0)])),
  })),
  getStickerPlacementCounts: vi.fn(async (imageIds: number[]) =>
    Object.fromEntries(imageIds.map((id) => [id, id * 3 + 1]))
  ),
  getRemixGalleryCardSummaries: vi.fn(
    async ({ imageIds, browsingLevel, storylinesFor }: RemixArgs) =>
      Object.fromEntries(
        imageIds.map((id) => [
          id,
          {
            count: id * 100 + browsingLevel,
            entries: [],
            storylines: storylinesFor
              ? { count: (storylinesFor.viewer?.id ?? 0) + id, entries: [] }
              : undefined,
          },
        ])
      )
  ),
}));

vi.mock('~/server/services/sticker-placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerPlacementService>()),
  getStickerPlacementsAndCounts: services.getStickerPlacementsAndCounts,
  getStickerPlacementCounts: services.getStickerPlacementCounts,
}));
vi.mock('~/server/services/remix-gallery.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixGalleryService>()),
  getRemixGalleryCardSummaries: services.getRemixGalleryCardSummaries,
}));

import { placementCaller } from '~/server/routers/__tests__/placement.router.test-utils';

const IDS = [11, 12, 13];
type Folded = { stickers?: { placements?: unknown; counts: unknown }; remix?: unknown };

beforeEach(() => vi.clearAllMocks());

describe('placement router — the folded card read answers what the separate reads answer', () => {
  it('for a signed-in viewer: placements, counts and remix summaries at their level', async () => {
    const caller = placementCaller();
    const folded = (await caller.getImageCardSummaries({
      imageIds: IDS,
      stickers: 'placements',
      remix: true,
      browsingLevel: 4,
    })) as Folded;

    expect(folded.stickers).toEqual(await caller.getStickerPlacementsAndCounts({ imageIds: IDS }));
    expect(folded.remix).toEqual(
      await caller.getRemixGalleryCardSummaries({ imageIds: IDS, browsingLevel: 4 })
    );
  });

  it("carries a moderator's standing into the sticker half", async () => {
    const caller = placementCaller({ user: { id: 913, isModerator: true } });
    const folded = (await caller.getImageCardSummaries({
      imageIds: IDS,
      stickers: 'placements',
    })) as Folded;

    expect(folded.stickers).toEqual(await caller.getStickerPlacementsAndCounts({ imageIds: IDS }));
  });

  it('counts alone, where only counts are asked for, without reading placements', async () => {
    const caller = placementCaller();
    const folded = (await caller.getImageCardSummaries({
      imageIds: IDS,
      stickers: 'counts',
    })) as Folded;

    expect(folded.stickers?.counts).toEqual(
      await caller.getStickerPlacementCounts({ imageIds: IDS })
    );
    expect(folded.stickers?.placements).toBeUndefined();
    expect(services.getStickerPlacementsAndCounts).not.toHaveBeenCalled();
  });

  it('applies the same storylines gate as the remix procedure', async () => {
    const caller = placementCaller({ features: { storylines: false } });
    const folded = (await caller.getImageCardSummaries({
      imageIds: IDS,
      remix: true,
      browsingLevel: 2,
    })) as Folded;

    expect(folded.remix).toEqual(
      await caller.getRemixGalleryCardSummaries({ imageIds: IDS, browsingLevel: 2 })
    );
    expect(services.getRemixGalleryCardSummaries.mock.calls[0][0].storylinesFor).toBeUndefined();
  });

  it('defaults an omitted level the way the remix procedure does', async () => {
    const caller = placementCaller();
    const folded = (await caller.getImageCardSummaries({ imageIds: IDS, remix: true })) as Folded;

    expect(folded.remix).toEqual(await caller.getRemixGalleryCardSummaries({ imageIds: IDS }));
  });

  it('reads only the halves it is asked for', async () => {
    const folded = (await placementCaller().getImageCardSummaries({
      imageIds: IDS,
      stickers: 'placements',
    })) as Folded;

    expect(folded.remix).toBeUndefined();
    expect(services.getRemixGalleryCardSummaries).not.toHaveBeenCalled();
    expect(services.getStickerPlacementCounts).not.toHaveBeenCalled();
  });

  it('refuses more ids than one chunk', async () => {
    const imageIds = Array.from({ length: 101 }, (_, index) => index + 1);

    await expect(
      placementCaller().getImageCardSummaries({ imageIds, stickers: 'counts', remix: true })
    ).rejects.toThrow();
    expect(services.getStickerPlacementCounts).not.toHaveBeenCalled();
    expect(services.getRemixGalleryCardSummaries).not.toHaveBeenCalled();
  });
});
