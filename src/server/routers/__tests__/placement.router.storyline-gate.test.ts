import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FreePlacementService from '~/server/services/free-placement.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type * as PlacementService from '~/server/services/placement.service';
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
