import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The currency a placement is charged in comes from the REQUEST'S DOMAIN, and
 * from nowhere else.
 *
 * Everything below the router is typed to require it, so an omission is a
 * compile error — but a hardcoded `'yellow'` compiles perfectly and silently
 * reverts the whole green path. Only a test at this boundary distinguishes
 * "derived from the domain" from "a literal that happens to be right on .red".
 */

import type * as StickerPlacementService from '~/server/services/sticker-placement.service';
import type * as RemixGalleryService from '~/server/services/remix-gallery.service';

const { createStickerPlacement, createRemixGallerySubmission } = vi.hoisted(() => ({
  createStickerPlacement: vi.fn(async () => ({ id: 1 })),
  createRemixGallerySubmission: vi.fn(async () => ({ id: 2 })),
}));

// Spread the real modules and override only the two writers: a hand-listed mock
// would couple this test to every export the router happens to import today.
vi.mock('~/server/services/sticker-placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerPlacementService>()),
  createStickerPlacement,
}));
vi.mock('~/server/services/remix-gallery.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixGalleryService>()),
  createRemixGallerySubmission,
}));

import { placementRouter } from '~/server/routers/placement.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { STICKER_PLACEMENT_MIN_SCALE } from '~/shared/utils/sticker-placement';

const PLACER = 42;

// Sized off the schema's own bound rather than a literal, so a future change to
// the allowed range moves this with it instead of failing validation here.
const STICKER_DATA = {
  cosmeticId: 7,
  x: 0.1,
  y: 0.1,
  scale: STICKER_PLACEMENT_MIN_SCALE,
  rotation: 0,
};

const callerOn = (isGreen: boolean) =>
  placementRouter.createCaller({
    user: { id: PLACER, isModerator: false },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { isGreen, stickers: true, stickerPlacement: true, remixGallery: true },
  } as never);

beforeEach(() => vi.clearAllMocks());

describe('placement router — the charged currency is the domain’s', () => {
  it.each([
    [true, 'green'],
    [false, 'yellow'],
  ] as const)('charges a sticker placement in %s Buzz', async (isGreen, expected) => {
    await callerOn(isGreen).createSticker({
      imageId: 99,
      data: STICKER_DATA,
    } as never);

    expect(createStickerPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ spendType: expected, placerId: PLACER })
    );
  });

  it.each([
    [true, 'green'],
    [false, 'yellow'],
  ] as const)('charges a remix gallery submission in %s Buzz', async (isGreen, expected) => {
    await callerOn(isGreen).submitToRemixGallery({
      hostImageId: 11,
      imageId: 12,
      expectedPrice: 100,
    } as never);

    expect(createRemixGallerySubmission).toHaveBeenCalledWith(
      expect.objectContaining({ spendType: expected, placerId: PLACER })
    );
  });

  // The one a schema change could silently undo: `...input` spreads BEFORE
  // `spendType`, and the zod schemas strip unknown keys, so a client sending its
  // own currency is ignored twice over. Asserted because "the schema strips it"
  // is a property of a file this one does not own.
  it('ignores a client-supplied currency on both surfaces', async () => {
    await callerOn(true).createSticker({
      imageId: 99,
      data: STICKER_DATA,
      spendType: 'yellow',
    } as never);
    await callerOn(true).submitToRemixGallery({
      hostImageId: 11,
      imageId: 12,
      expectedPrice: 100,
      spendType: 'yellow',
    } as never);

    expect(createStickerPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ spendType: 'green' })
    );
    expect(createRemixGallerySubmission).toHaveBeenCalledWith(
      expect.objectContaining({ spendType: 'green' })
    );
  });

  /**
   * The same shape as the currency above, and higher stakes.
   *
   * `createFreePlacement` takes `placerId` as a plain number and cannot tell
   * where it came from, and every check below it — the daily allowance, the
   * never-twice rule, self-placement — is *about* that id rather than a check
   * *of* it. So a router reading it off the payload would let anyone spend
   * someone else's free placement and submit under their account, with nothing
   * downstream raising.
   *
   * Two independent things keep that true — the schema has no `placerId`, so zod
   * strips it, and `...input` spreads before the session id — and this asserts
   * the outcome rather than either mechanism. Measured: breaking one alone does
   * not fail it, because the other still holds; adding `placerId` to the schema
   * AND flipping the spread order does.
   */
  it('takes placerId from the session even when the client sends its own', async () => {
    await callerOn(false).submitToRemixGallery({
      hostImageId: 11,
      imageId: 12,
      free: true,
      placerId: PLACER + 1,
    } as never);

    expect(createRemixGallerySubmission).toHaveBeenCalledWith(
      expect.objectContaining({ placerId: PLACER, free: true })
    );
  });

  it('defaults a submission to paid when the client says nothing', async () => {
    // The free path is asked for, never assumed: a client cached from before the
    // free tier existed must keep paying rather than start spending an allowance
    // it does not know it has.
    await callerOn(false).submitToRemixGallery({
      hostImageId: 11,
      imageId: 12,
      expectedPrice: 100,
    } as never);

    expect(createRemixGallerySubmission).toHaveBeenCalledWith(
      expect.objectContaining({ free: false })
    );
  });
});
