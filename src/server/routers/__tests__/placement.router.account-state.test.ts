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
import { guardedProcedure } from '~/server/trpc';
import {
  PLACER,
  STICKER_DATA,
  placementCaller,
} from '~/server/routers/__tests__/placement.router.test-utils';

/**
 * The two procedures that write a placement — one case each, and deliberately no
 * `free: true` twin.
 *
 * The free tier is covered, but not by a second call here: the guard is
 * middleware, so it refuses before the payload is looked at and cannot behave
 * differently for an offer it never sees. A free twin would run the identical
 * path — both create services are replaced above, so `free: true` reaches a mock
 * argument and `createFreePlacement` is never entered — and no mutation of the
 * guard distinguishes the two. What covers the free tier is that both offers go
 * through these procedures and nothing else, which `guards exactly the
 * placement-writing mutations` below asserts against the router itself;
 * `free-placement.service.test.ts` covers the free service's own guard.
 */
const CREATE_CALLS = [
  {
    name: 'createSticker',
    label: 'sticker',
    writer: createStickerPlacement,
    input: { imageId: 99, data: STICKER_DATA },
  },
  {
    name: 'submitToRemixGallery',
    label: 'remix gallery',
    writer: createRemixGallerySubmission,
    input: { hostImageId: 11, imageId: 12, expectedPrice: 100 },
  },
] as const;

type ProcedureDef = { _def: { type: string; middlewares: unknown[] } };

const procedures = (placementRouter as unknown as { _def: { procedures: Record<string, unknown> } })
  ._def.procedures as Record<string, ProcedureDef>;

const guardedMiddlewares = (guardedProcedure as unknown as ProcedureDef)._def.middlewares;

/** Whether a procedure is built from `guardedProcedure` — its chain, not its name. */
const isGuarded = (procedure: ProcedureDef) =>
  guardedMiddlewares.every((middleware, index) => procedure._def.middlewares[index] === middleware);

const mutationNames = Object.entries(procedures)
  .filter(([, procedure]) => procedure._def.type === 'mutation')
  .map(([name]) => name);

// Each state names the middleware that refuses it. All three throw FORBIDDEN, so
// the code alone cannot say which gate fired — and a call refused for the wrong
// reason (an unset onboarding bit, say) would otherwise read as a working mute.
const REFUSED_STATES = [
  { state: 'muted', user: { muted: true }, message: /restricted/i },
  { state: 'banned', user: { bannedAt: new Date('2026-01-01') }, message: /banned/i },
] as const;

beforeEach(() => vi.clearAllMocks());

describe('placement router — account state refuses a placement', () => {
  /**
   * The load-bearing case, and the one that does not lean on the caller tests
   * below: exactly the two placement-writing mutations are built from
   * `guardedProcedure`, read off each procedure's middleware chain.
   *
   * A list of names would have been silenced by pasting the new name into it,
   * and would have churned on every unrelated query added to the router. This
   * fails on what matters — a third create mutation added without the guard, or
   * either of these two quietly reverted.
   */
  it('guards exactly the placement-writing mutations', () => {
    expect(guardedMiddlewares.length).toBeGreaterThan(0);
    expect(mutationNames.length).toBeGreaterThan(CREATE_CALLS.length);

    const guarded = mutationNames.filter((name) => isGuarded(procedures[name]));

    expect(guarded.sort()).toEqual([...new Set(CREATE_CALLS.map((call) => call.name))].sort());
  });

  for (const { label, name, writer, input } of CREATE_CALLS) {
    for (const { state, user, message } of REFUSED_STATES) {
      it(`refuses a ${state} user on ${label}`, async () => {
        await expect(placementCaller({ user })[name](input)).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: expect.stringMatching(message),
        });

        // The half that matters. A refusal thrown after the service already ran
        // would be a message rather than a guard, and on the paid path the
        // service is where the Buzz is taken.
        expect(writer).not.toHaveBeenCalled();
      });
    }

    // The control. The refusals prove nothing unless the same call succeeds for
    // an account in none of those states — a broken input shape refuses
    // everywhere and reads as a working guard.
    it(`lets an ordinary user through on ${label}`, async () => {
      await expect(placementCaller()[name](input)).resolves.toBeDefined();
      expect(writer).toHaveBeenCalledTimes(1);
      expect(writer).toHaveBeenCalledWith(expect.objectContaining({ placerId: PLACER }));
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
      placementCaller({ user: { onboarding: 0 } }).createSticker({
        imageId: 99,
        data: STICKER_DATA,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/onboarding/i) });

    expect(createStickerPlacement).not.toHaveBeenCalled();
  });
});
