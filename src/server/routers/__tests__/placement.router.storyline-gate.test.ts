import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FreePlacementService from '~/server/services/free-placement.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type * as PlacementService from '~/server/services/placement.service';
import { placementRouter } from '~/server/routers/placement.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { placementCaller } from './placement.router.test-utils';

const { services } = vi.hoisted(() => ({
  services: {
    resolvePlacementSpaceFor: vi.fn(async () => ({})),
    getPlacementSpaceRow: vi.fn(async () => null),
    clearPlacementSpace: vi.fn(async () => undefined),
    getPlacementSpaces: vi.fn(async () => []),
    setPlacementSpace: vi.fn(async () => undefined),
    placementPriceRange: vi.fn(async () => ({ min: 0, max: 0, freeSlotCap: 0 })),
    getFreePlacementAllowance: vi.fn(async () => ({ used: 0, remaining: 1, resetsAt: new Date() })),
    hasUsedFreePlacementOn: vi.fn(async () => false),
  },
}));

vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor: services.resolvePlacementSpaceFor,
  getPlacementSpaceRow: services.getPlacementSpaceRow,
  clearPlacementSpace: services.clearPlacementSpace,
  getPlacementSpaces: services.getPlacementSpaces,
  setPlacementSpace: services.setPlacementSpace,
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: services.placementPriceRange,
}));
vi.mock('~/server/services/free-placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FreePlacementService>()),
  getFreePlacementAllowance: services.getFreePlacementAllowance,
  hasUsedFreePlacementOn: services.hasUsedFreePlacementOn,
}));

beforeEach(() => vi.clearAllMocks());

/**
 * Every shared endpoint that takes a client-supplied `surface`, with an input
 * that is otherwise valid for it. `placementSurfaceSchema` is built from the
 * whole surface table, so adding `storyline` there made it a schema-valid value
 * on all of these at once.
 */
const SURFACE_ENDPOINTS = (surface: string) =>
  [
    ['getSpace', { surface, targetType: 'image', targetId: 1 }, 'resolvePlacementSpaceFor'],
    ['getSpaceRow', { surface, entityType: 'post', entityId: 1 }, 'getPlacementSpaceRow'],
    ['clearSpace', { surface, entityType: 'post', entityId: 1 }, 'clearPlacementSpace'],
    ['getMySpaces', { surface }, 'getPlacementSpaces'],
    ['getPriceRange', { surface }, 'placementPriceRange'],
    [
      'setSpace',
      { surface, entityType: 'post', entityId: 1, mode: 'review', price: 100 },
      'setPlacementSpace',
    ],
    ['getFreeStanding', { surface, targetType: 'image', targetId: 1 }, 'hasUsedFreePlacementOn'],
  ] as const;

/**
 * 🔴 A storyline space opens at price 0 by default. That is safe only once the
 * storyline creation path refuses a target that is not a storyline chapter, so
 * until the storyline feature wires its own flag and that check, no shared
 * endpoint may read or configure one — whatever flags the caller holds.
 *
 * Delete this file when storylines are routed, and replace it with the flag and
 * target tests that make the open default safe.
 */
describe('the shared space endpoints refuse storylines', () => {
  // Every flag on, so a refusal can only be the storyline gate itself and not a
  // sticker or remix flag the caller happens to lack.
  const caller = () =>
    placementCaller({
      features: {
        stickers: true,
        stickerPlacement: true,
        remixGallery: true,
        promotions: true,
        storylines: true,
      },
    });

  it.each(SURFACE_ENDPOINTS('storyline'))('%s refuses a storyline', async (name, input) => {
    await expect(caller()[name](input)).rejects.toThrow(/storylines: this is not available yet/);
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
  });

  // The positive arm: the same calls on a launched surface reach their service,
  // so the refusal above is about the surface and not about the input shape.
  it.each(SURFACE_ENDPOINTS('sticker'))(
    '%s still serves a sticker space',
    async (name, input, service) => {
      await caller()[name](input);
      expect(services[service]).toHaveBeenCalledTimes(1);
    }
  );
});

/**
 * The storyline procedures exist and are typed so the UI can build against
 * them, and every one refuses until storylines are routed: the body itself
 * refuses, so no flag a caller holds can open it. Each is given an otherwise valid input, so the refusal is the
 * gate and not validation.
 */
describe('the storyline procedures refuse until routed', () => {
  const STORYLINE_PROCEDURES = [
    ['getStorylineSpace', { storylineId: 1 }],
    ['setStorylineSpace', { storylineId: 1, mode: 'review', price: 0 }],
    ['getStorylineContinuePrice', { parentPostId: 1 }],
    ['getPendingStorylineContinuations', {}],
    ['actOnStorylineContinuation', { placementId: 1, action: 'approve' }],
    ['submitStorylineContinuation', { parentPostId: 1, postId: 2, expectedPrice: 0 }],
    ['getMyStorylineContinuations', {}],
    ['retractStorylineContinuation', { placementId: 1 }],
  ] as const;

  // Read off the router, so a storyline procedure added without a row here
  // fails instead of going unchecked.
  it('lists every storyline procedure the router has', () => {
    const routed = Object.keys(
      (placementRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
        .procedures
    ).filter((name) => /storyline/i.test(name));
    expect(routed.sort()).toEqual(STORYLINE_PROCEDURES.map(([name]) => name).sort());
  });

  // Signed out, every one but the public price read refuses before its body.
  it.each(STORYLINE_PROCEDURES.filter(([name]) => name !== 'getStorylineContinuePrice'))(
    '%s needs a signed-in caller',
    async (name, input) => {
      const anonymous = placementRouter.createCaller({
        user: undefined,
        acceptableOrigin: true,
        tokenScope: TokenScope.Full,
        features: { storylines: true },
      } as never) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
      // The gate's own error is also UNAUTHORIZED, so the code alone cannot tell a
      // signed-in check from the body refusing. The message has to be the auth
      // middleware's, not the gate's.
      const error = await anonymous[name](input).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect((error as Error).message).not.toMatch(/not available yet/);
    }
  );

  it('refuses auto as a storyline mode at the input', async () => {
    await expect(
      placementCaller().setStorylineSpace({ storylineId: 1, mode: 'auto', price: 0 })
    ).rejects.toThrow(/mode/);
  });

  it.each(STORYLINE_PROCEDURES)('%s refuses', async (name, input) => {
    const caller = placementCaller({
      features: {
        stickers: true,
        stickerPlacement: true,
        remixGallery: true,
        promotions: true,
        storylines: true,
      },
    });
    await expect(caller[name](input)).rejects.toThrow(/storylines: this is not available yet/);
  });

  // A required price: omitting it is a validation error, not a submission that
  // charges whatever the creator set a moment ago.
  it('refuses a submission without the price the contributor was shown', async () => {
    await expect(
      placementCaller().submitStorylineContinuation({ parentPostId: 1, postId: 2 })
    ).rejects.toThrow(/expectedPrice/);
  });
});
