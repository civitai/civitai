import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A muted or banned account cannot make a placement, on either surface, paid or
 * free.
 *
 * Placing a sticker or submitting a remix publishes content onto someone else's
 * image, so it is a posting channel aimed at a specific person — the thing a
 * mute exists to close. Both create procedures ran on `protectedProcedure` until
 * 2026-08-21, which refuses a ban and says nothing about a mute.
 *
 * Asserted at the ROUTER rather than on the services, because the refusal is a
 * property of the procedure the mutation is built from — nothing inside either
 * service would change if the wrapper were swapped back.
 */

import type * as StickerPlacementService from '~/server/services/sticker-placement.service';
import type * as RemixGalleryService from '~/server/services/remix-gallery.service';

const { createStickerPlacement, createRemixGallerySubmission } = vi.hoisted(() => ({
  createStickerPlacement: vi.fn(async () => ({ id: 1 })),
  createRemixGallerySubmission: vi.fn(async () => ({ id: 2 })),
}));

vi.mock('~/server/services/sticker-placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerPlacementService>()),
  createStickerPlacement,
}));
vi.mock('~/server/services/remix-gallery.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixGalleryService>()),
  createRemixGallerySubmission,
}));

import { placementRouter } from '~/server/routers/placement.router';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { STICKER_PLACEMENT_MIN_SCALE } from '~/shared/utils/sticker-placement';

const PLACER = 42;

const STICKER_DATA = {
  cosmeticId: 7,
  x: 0.1,
  y: 0.1,
  scale: STICKER_PLACEMENT_MIN_SCALE,
  rotation: 0,
};

/**
 * The two procedures that write a placement, each in both offers.
 *
 * `free` is its own case rather than a variant of the paid one because it
 * reaches a different service — `createFreePlacement` — so a guard applied to
 * the paid write alone would leave the free tier open with every paid case here
 * still green.
 */
const CREATE_CALLS = [
  {
    name: 'createSticker',
    label: 'sticker (paid)',
    writer: createStickerPlacement,
    input: { imageId: 99, data: STICKER_DATA },
  },
  {
    name: 'createSticker',
    label: 'sticker (free)',
    writer: createStickerPlacement,
    input: { imageId: 99, data: STICKER_DATA, free: true },
  },
  {
    name: 'submitToRemixGallery',
    label: 'remix gallery (paid)',
    writer: createRemixGallerySubmission,
    input: { hostImageId: 11, imageId: 12, expectedPrice: 100 },
  },
  {
    name: 'submitToRemixGallery',
    label: 'remix gallery (free)',
    writer: createRemixGallerySubmission,
    input: { hostImageId: 11, imageId: 12, free: true },
  },
] as const;

/**
 * Every other procedure on the router, listed so that ADDING one fails here.
 *
 * The point is not the names. A second placement-writing mutation added later
 * would be absent from `CREATE_CALLS`, exercised by nothing, and this file would
 * still report green about the two procedures it already knew — which is how a
 * hand-enumerated test misses a hand-enumeration bug. Whoever adds a procedure
 * has to say which side of the line it is on.
 */
const NON_CREATE_PROCEDURES = [
  'getSpace',
  'getSpaceRow',
  'clearSpace',
  'getMySpaces',
  'getPriceRange',
  'setSpace',
  'getFreeStanding',
  'getStickerPlacements',
  'getStickerPlacementDetail',
  'getStickerPlacementCounts',
  'getSettlementStates',
  'actOnStickers',
  'setStickerCommentHidden',
  'isSuspended',
  'suspendPlacer',
  'removePlacement',
  'restorePlacer',
  'getPending',
  'getMyStickerPlacements',
  'countPendingFrom',
  'getRemixGallery',
  'getRemixGalleryVisibility',
  'getRemixGalleryFreeEligibility',
  'getPendingRemixGallerySubmissions',
  'getMyRemixGallerySubmissions',
  'retractRemixGallerySubmission',
  'setRemixGalleryPins',
  'actOnRemixGallerySubmission',
  'declineOutOfBandRemixGallerySubmissions',
];

const procedureNames = Object.keys(
  (placementRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures
);

type UserOverrides = {
  muted?: boolean;
  bannedAt?: Date | null;
  onboarding?: number;
};

const callerAs = (overrides: UserOverrides = {}) =>
  placementRouter.createCaller({
    user: {
      id: PLACER,
      isModerator: false,
      muted: false,
      bannedAt: null,
      // The finished wizard. `guardedProcedure` is `verifiedProcedure` plus the
      // mute check, so an unset bit would refuse every call below for the wrong
      // reason and the mute cases would pass with the mute doing nothing.
      onboarding: OnboardingSteps.Buzz,
      ...overrides,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { isGreen: false, stickers: true, stickerPlacement: true, remixGallery: true },
  } as never) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;

const REFUSED_STATES = [
  { state: 'muted', overrides: { muted: true } },
  { state: 'banned', overrides: { bannedAt: new Date('2026-01-01') } },
] as const;

beforeEach(() => vi.clearAllMocks());

describe('placement router — account state refuses a placement', () => {
  it('classifies every procedure the router exposes', () => {
    expect(procedureNames.length).toBeGreaterThan(0);

    const classified = [...new Set(CREATE_CALLS.map((call) => call.name)), ...NON_CREATE_PROCEDURES];
    expect(procedureNames.slice().sort()).toEqual(classified.slice().sort());
  });

  for (const { label, name, writer, input } of CREATE_CALLS) {
    for (const { state, overrides } of REFUSED_STATES) {
      it(`refuses a ${state} user on ${label}`, async () => {
        await expect(callerAs(overrides)[name](input)).rejects.toMatchObject({ code: 'FORBIDDEN' });

        // The half that matters. A refusal thrown after the service already ran
        // would be a message rather than a guard, and on the paid path the
        // service is where the Buzz is taken.
        expect(writer).not.toHaveBeenCalled();
      });
    }

    // The control. Eight refusals prove nothing unless the same call succeeds
    // for an account in none of those states — a broken input shape refuses
    // everywhere and reads as a working guard.
    it(`lets an ordinary user through on ${label}`, async () => {
      await expect(callerAs()[name](input)).resolves.toBeDefined();
      expect(writer).toHaveBeenCalledTimes(1);
    });
  }

  /**
   * The onboarding half of `guardedProcedure`, pinned because it is the only
   * behaviour the swap added beyond the mute and every case above completes the
   * wizard, so nothing else here would notice it.
   *
   * Measured before shipping: of the 227 users who have ever placed, zero lack
   * this bit, and the wizard shields the whole site until it is set — so it
   * refuses a request that cannot currently be made. If that stops being true,
   * this is the test that names what changed.
   */
  it('refuses a user who has not finished onboarding', async () => {
    await expect(
      callerAs({ onboarding: 0 }).createSticker({ imageId: 99, data: STICKER_DATA })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(createStickerPlacement).not.toHaveBeenCalled();
  });
});
