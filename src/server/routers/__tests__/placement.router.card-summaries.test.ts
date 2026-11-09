import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemixGalleryService from '~/server/services/remix-gallery.service';
import type * as StickerPlacementService from '~/server/services/sticker-placement.service';
import type * as HttpErrors from '~/server/prom/http-errors';

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
// What a failed half is reported through instead of being thrown: the 5xx counter, and the log
// line (`logToAxiom`, through the canonical logging mock registered in setup.ts).
const reporter = vi.hoisted(() => ({ recordTrpcError: vi.fn() }));
vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpErrors>()),
  recordTrpcError: reporter.recordTrpcError,
}));

import { TRPCError } from '@trpc/server';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { placementCaller } from '~/server/routers/__tests__/placement.router.test-utils';

const IDS = [11, 12, 13];
type HalfError = { code: string; message: string };
type Folded = {
  stickers?: { placements?: unknown; counts: unknown };
  remix?: unknown;
  errors?: { stickers?: HalfError; remix?: HalfError };
};

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

describe('placement router — each half of the folded card read fails on its own', () => {
  it('a failed remix half still returns the sticker half, and answers the remix half as an error', async () => {
    const caller = placementCaller();
    services.getRemixGalleryCardSummaries.mockRejectedValueOnce(
      new Error('remix read failed: relation does not exist')
    );

    const folded = (await caller.getImageCardSummaries({
      imageIds: IDS,
      stickers: 'placements',
      remix: true,
      browsingLevel: 4,
    })) as Folded;

    expect(folded.stickers).toEqual(await caller.getStickerPlacementsAndCounts({ imageIds: IDS }));
    expect(folded.remix).toBeUndefined();
    expect(folded.errors?.stickers).toBeUndefined();
    expect(folded.errors?.remix?.code).toBe('INTERNAL_SERVER_ERROR');
    // Masked exactly as the error formatter masks a thrown server fault: the driver's text never
    // reaches the client, a ref does.
    expect(folded.errors?.remix?.message).not.toContain('relation does not exist');
    expect(folded.errors?.remix?.message).toMatch(/\(ref: [0-9a-f]{12}\)/);
  });

  it('a failed sticker half still returns the remix half, and answers the sticker half as an error', async () => {
    const caller = placementCaller();
    services.getStickerPlacementCounts.mockRejectedValueOnce(new Error('counts read failed'));

    const folded = (await caller.getImageCardSummaries({
      imageIds: IDS,
      stickers: 'counts',
      remix: true,
      browsingLevel: 2,
    })) as Folded;

    expect(folded.remix).toEqual(
      await caller.getRemixGalleryCardSummaries({ imageIds: IDS, browsingLevel: 2 })
    );
    expect(folded.stickers).toBeUndefined();
    expect(folded.errors?.remix).toBeUndefined();
    expect(folded.errors?.stickers?.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('reports a failed half the way a thrown procedure error is reported, naming the half', async () => {
    services.getRemixGalleryCardSummaries.mockRejectedValueOnce(new Error('remix read failed'));

    const folded = (await placementCaller({ user: { id: 917 } }).getImageCardSummaries({
      imageIds: IDS,
      stickers: 'placements',
      remix: true,
    })) as Folded;

    expect(reporter.recordTrpcError).toHaveBeenCalledTimes(1);
    expect(reporter.recordTrpcError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR' }),
      'placement.getImageCardSummaries'
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    const [line, datastream] = loggingMock.logToAxiom.mock.calls[0];
    expect(datastream).toBe('civitai-prod');
    // The ref the client was shown is the one logged, so a user's report can be found.
    const shownRef = folded.errors?.remix?.message.match(/\(ref: ([0-9a-f]{12})\)/)?.[1];
    expect(shownRef).toBeDefined();
    expect(line).toEqual(
      expect.objectContaining({
        path: 'placement.getImageCardSummaries',
        half: 'remix',
        user: 917,
        errorRef: shownRef,
        type: 'error',
      })
    );
    expect(line).not.toHaveProperty('input');
  });

  it('answers without waiting for the log write, even one that never finishes', async () => {
    loggingMock.logToAxiom.mockReturnValueOnce(new Promise<void>(() => undefined));
    services.getRemixGalleryCardSummaries.mockRejectedValueOnce(new Error('remix read failed'));

    const answer = placementCaller().getImageCardSummaries({
      imageIds: IDS,
      stickers: 'counts',
      remix: true,
    });
    const timedOut = Symbol('timed out');
    const settled = await Promise.race([
      answer,
      new Promise((resolve) => setTimeout(() => resolve(timedOut), 1000)),
    ]);

    expect(settled).not.toBe(timedOut);
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect((settled as Folded).errors?.remix?.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('answers even when the log write rejects or throws', async () => {
    loggingMock.logToAxiom
      .mockImplementationOnce(() => Promise.reject(new Error('ingest down')))
      .mockImplementationOnce(() => {
        throw new Error('logger broke');
      });
    services.getStickerPlacementCounts.mockRejectedValueOnce(new Error('counts read failed'));
    services.getRemixGalleryCardSummaries.mockRejectedValueOnce(new Error('remix read failed'));

    const folded = (await placementCaller().getImageCardSummaries({
      imageIds: IDS,
      stickers: 'counts',
      remix: true,
    })) as Folded;

    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(2);
    expect(folded.errors?.stickers?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(folded.errors?.remix?.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it("keeps a client-fault half's own code and message, as the procedure would have shown it", async () => {
    services.getStickerPlacementsAndCounts.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'No such image' })
    );

    const folded = (await placementCaller().getImageCardSummaries({
      imageIds: IDS,
      stickers: 'placements',
      remix: true,
    })) as Folded;

    expect(folded.errors?.stickers).toEqual({ code: 'NOT_FOUND', message: 'No such image' });
    expect(folded.remix).toEqual(
      await placementCaller().getRemixGalleryCardSummaries({ imageIds: IDS })
    );
  });

  it('never lets the edge keep an answer carrying a failed half', async () => {
    const cache = { edgeTTL: 60, browserTTL: 60 };
    services.getRemixGalleryCardSummaries.mockRejectedValueOnce(new Error('remix read failed'));

    await placementCaller({ cache }).getImageCardSummaries({
      imageIds: IDS,
      stickers: 'counts',
      remix: true,
    });

    expect(cache).toEqual({ edgeTTL: 0, browserTTL: 0, canCache: false });
  });

  it('CONTROL: an answer with both halves keeps its edge cache settings', async () => {
    const cache = { edgeTTL: 60, browserTTL: 60 };

    await placementCaller({ cache }).getImageCardSummaries({
      imageIds: IDS,
      stickers: 'counts',
      remix: true,
    });

    expect(cache).toEqual({ edgeTTL: 60, browserTTL: 60 });
  });

  it('CONTROL: with both halves answered there is no error and nothing is reported', async () => {
    const folded = (await placementCaller().getImageCardSummaries({
      imageIds: IDS,
      stickers: 'placements',
      remix: true,
    })) as Folded;

    expect(folded.errors).toBeUndefined();
    expect(folded.stickers).toBeDefined();
    expect(folded.remix).toBeDefined();
    expect(reporter.recordTrpcError).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});
