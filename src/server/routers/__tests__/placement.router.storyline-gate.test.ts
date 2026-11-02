import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FreePlacementService from '~/server/services/free-placement.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type * as PlacementService from '~/server/services/placement.service';
import type * as StorylinePlacementService from '~/server/services/storyline-placement.service';
import { placementRouter } from '~/server/routers/placement.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { PLACER, placementCaller } from './placement.router.test-utils';

const { services, storylineServices } = vi.hoisted(() => ({
  storylineServices: {
    getStorylineSpace: vi.fn(async () => ({})),
    setStorylineSpace: vi.fn(async () => ({})),
    getStorylineContinuePrice: vi.fn(async () => ({})),
    getPendingStorylineContinuations: vi.fn(async () => ({ items: [], nextCursor: null })),
    actOnStorylineContinuation: vi.fn(async () => ({ settled: true })),
    createStorylinePlacement: vi.fn(async () => ({ id: 1 })),
    getMyStorylineContinuations: vi.fn(async () => ({ items: [], nextCursor: null })),
    retractStorylineContinuation: vi.fn(async () => ({ retracted: true })),
  },
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
vi.mock('~/server/services/storyline-placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylinePlacementService>()),
  ...storylineServices,
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
 * Every shared endpoint that takes a client-supplied `surface`, with otherwise valid input.
 * `placementSurfaceSchema` is built from the whole surface table, so `storyline` is schema-valid on
 * all of them.
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
 * 🔴 A storyline space opens at price 0 by default, and is keyed on a
 * storyline. The storyline procedures below are its only routes: each runs the
 * storyline flag and, where it reaches a chapter, the chapter check. No shared
 * endpoint may read or configure one, whatever flags the caller holds.
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
 * The storyline procedures, routed. Each is given an otherwise valid input, so
 * a refusal is the gate and not validation. The services are replaced here;
 * what they refuse is tested beside them, and the chapter check at this entry
 * is tested against the real service in `placement.router.storyline-routes`.
 */
describe('the storyline procedures', () => {
  const STORYLINE_PROCEDURES = [
    ['getStorylineSpace', { storylineId: 1 }, 'getStorylineSpace'],
    ['setStorylineSpace', { storylineId: 1, mode: 'review', price: 0 }, 'setStorylineSpace'],
    ['getStorylineContinuePrice', { parentPostId: 1 }, 'getStorylineContinuePrice'],
    ['getPendingStorylineContinuations', {}, 'getPendingStorylineContinuations'],
    [
      'actOnStorylineContinuation',
      { placementId: 1, action: 'approve' },
      'actOnStorylineContinuation',
    ],
    [
      'submitStorylineContinuation',
      { parentPostId: 1, postId: 2, expectedPrice: 0 },
      'createStorylinePlacement',
    ],
    ['getMyStorylineContinuations', {}, 'getMyStorylineContinuations'],
    ['retractStorylineContinuation', { placementId: 1 }, 'retractStorylineContinuation'],
  ] as const;

  /**
   * 🔴 Deliberately open without the flag, like `actOnStickers`: turning
   * storylines off must not leave a creator holding continuations they cannot
   * answer, or a contributor with Buzz held they cannot withdraw. Ownership is
   * the service's. Do not "fix" these by adding the gate.
   */
  const UNGATED = ['actOnStorylineContinuation', 'retractStorylineContinuation'];
  const GATED = STORYLINE_PROCEDURES.filter(([name]) => !UNGATED.includes(name));

  // Every other flag on, so a refusal can only be the storyline flag.
  const caller = (storylines: boolean) =>
    placementCaller({
      features: {
        stickers: true,
        stickerPlacement: true,
        remixGallery: true,
        promotions: true,
        storylines,
      },
    });

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
      // signed-in check from the gate refusing. The message has to be the auth
      // middleware's, not the gate's.
      const error = await anonymous[name](input).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect((error as Error).message).not.toMatch(/not available yet/);
      for (const service of Object.values(storylineServices))
        expect(service).not.toHaveBeenCalled();
    }
  );

  it('answers a signed-out viewer on the price read, as a stranger', async () => {
    const anonymous = placementRouter.createCaller({
      user: undefined,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      features: { storylines: true },
    } as never) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
    await anonymous.getStorylineContinuePrice({ parentPostId: 1 });
    expect(storylineServices.getStorylineContinuePrice).toHaveBeenCalledWith({
      parentPostId: 1,
      viewerId: undefined,
    });
  });

  it('refuses auto as a storyline mode at the input', async () => {
    await expect(
      caller(true).setStorylineSpace({ storylineId: 1, mode: 'auto', price: 0 })
    ).rejects.toThrow(/mode/);
  });

  it.each(GATED)('%s refuses without the storylines flag', async (name, input) => {
    const error = await caller(false)
      [name](input)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect((error as Error).message).toBe(STORYLINE_REFUSALS.notAvailable);
    for (const service of Object.values(storylineServices)) expect(service).not.toHaveBeenCalled();
  });

  // The control for the refusals above: the flag is the only thing that changed.
  it.each(STORYLINE_PROCEDURES)(
    '%s reaches its service with the flag',
    async (name, input, service) => {
      await caller(true)[name](input);
      expect(storylineServices[service]).toHaveBeenCalledTimes(1);
    }
  );

  it.each(UNGATED.map((name) => STORYLINE_PROCEDURES.find(([n]) => n === name)!))(
    '%s still answers with the flag off',
    async (name, input, service) => {
      await caller(false)[name](input);
      expect(storylineServices[service]).toHaveBeenCalledTimes(1);
    }
  );

  // Every id that scopes a service comes from the session. A client-sent one
  // would act as someone else.
  it('scopes every service to the caller', async () => {
    const c = caller(true);
    await c.getStorylineSpace({ storylineId: 1 });
    await c.setStorylineSpace({ storylineId: 1, mode: 'review', price: 0 });
    await c.getStorylineContinuePrice({ parentPostId: 1 });
    await c.getPendingStorylineContinuations({});
    await c.actOnStorylineContinuation({ placementId: 1, action: 'approve' });
    await c.submitStorylineContinuation({ parentPostId: 1, postId: 2, expectedPrice: 0 });
    await c.getMyStorylineContinuations({});
    await c.retractStorylineContinuation({ placementId: 1 });

    const s = storylineServices;
    expect(s.getStorylineSpace).toHaveBeenCalledWith({
      storylineId: 1,
      userId: PLACER,
      isModerator: false,
    });
    expect(s.setStorylineSpace).toHaveBeenCalledWith(expect.objectContaining({ userId: PLACER }));
    expect(s.getStorylineContinuePrice).toHaveBeenCalledWith({ parentPostId: 1, viewerId: PLACER });
    expect(s.getPendingStorylineContinuations).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: PLACER })
    );
    expect(s.actOnStorylineContinuation).toHaveBeenCalledWith({
      placementId: 1,
      ownerId: PLACER,
      action: 'approve',
    });
    expect(s.createStorylinePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ placerId: PLACER, parentPostId: 1, postId: 2, expectedPrice: 0 })
    );
    expect(s.getMyStorylineContinuations).toHaveBeenCalledWith(
      expect.objectContaining({ placerId: PLACER })
    );
    expect(s.retractStorylineContinuation).toHaveBeenCalledWith({
      placementId: 1,
      placerId: PLACER,
    });
  });

  // A required price: omitting it is a validation error, not a submission that
  // charges whatever the creator set a moment ago.
  it('refuses a submission without the price the contributor was shown', async () => {
    await expect(
      caller(true).submitStorylineContinuation({ parentPostId: 1, postId: 2 })
    ).rejects.toThrow(/expectedPrice/);
    expect(storylineServices.createStorylinePlacement).not.toHaveBeenCalled();
  });
});
