import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Where the gallery visibility query gets the owner's name.
 *
 * `placement-space.service` is real here. remix-gallery.service.test.ts replaces
 * it, so it cannot see whether the name on the resolved space is the one that
 * reaches the caller.
 */
const ownerLookup = dbMock.dbRead.user.findUnique;

// The Kysely placement reads this path makes. Their rows, against a real database, are pinned in
// placement-reads.kysely-parity.test.ts.
const placementReads = vi.hoisted(() => ({
  getImagePlacementTarget: vi.fn(),
  listPlacementSpacesFor: vi.fn(),
  countPlacements: vi.fn(),
  getUserPlacementScore: vi.fn(),
}));
vi.mock('@civitai/db-queries/placement', () => placementReads);
const hostImageRead = placementReads.getImagePlacementTarget;
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  getCapTier: async () => null,
  getCapTierViaKysely: async () => null,
}));

// Stubbed rather than spread, as in remix-gallery.service.test.ts: each pulls
// the buzz service and its import graph, and nothing here reaches them.
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow: vi.fn(),
  settlePlacement: vi.fn(),
  FEE_WAIVING_ACTIONS: [],
}));
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace: vi.fn() }));
vi.mock('~/server/rewards/active/remixAccept.reward', () => ({
  remixAcceptReward: { apply: vi.fn() },
}));
vi.mock('~/server/services/free-placement.service', () => ({
  createFreePlacement: vi.fn(),
  getFreePlacementAllowance: vi.fn(),
  hasUsedFreePlacementOn: vi.fn(),
}));

const { getRemixGalleryVisibility } = await import('~/server/services/remix-gallery.service');

const OWNER = 41;
const HOST_IMAGE = 74;

const hostOwnedBy = (username: string | null) =>
  hostImageRead.mockResolvedValue({
    id: HOST_IMAGE,
    userId: OWNER,
    postId: null,
    type: 'image',
    username,
  });

const visibility = () =>
  getRemixGalleryVisibility({
    hostImageId: HOST_IMAGE,
    browsingLevel: allBrowsingLevelsFlag,
    domainLevels: allBrowsingLevelsFlag,
  });

beforeEach(() => {
  vi.clearAllMocks();
  placementReads.listPlacementSpacesFor.mockResolvedValue([]);
  placementReads.countPlacements.mockResolvedValue(0);
  placementReads.getUserPlacementScore.mockResolvedValue([{ score: 0 }]);
  // One row answering every raw read on this path: the has-entries probe and
  // the host image. The creator score comes from `getUserPlacementScore` above.
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    { score: 0, exists: false, count: 0, nsfwLevel: 1, minor: false, showable: true },
  ]);
});

describe('the owner named by the gallery visibility query', () => {
  it('is the one read with the host image, with no user lookup of its own', async () => {
    hostOwnedBy('host-owner');
    // What the dropped lookup returned for the same account, so the name is
    // right either way and only the query count separates the two.
    ownerLookup.mockResolvedValue({ username: 'host-owner' });

    await expect(visibility()).resolves.toMatchObject({
      ownerId: OWNER,
      ownerUsername: 'host-owner',
    });
    expect(hostImageRead).toHaveBeenCalledTimes(1);
    expect(ownerLookup).not.toHaveBeenCalled();
  });

  it('is null for an owner with no username', async () => {
    hostOwnedBy(null);
    ownerLookup.mockResolvedValue({ username: null });

    await expect(visibility()).resolves.toMatchObject({ ownerId: OWNER, ownerUsername: null });
    expect(ownerLookup).not.toHaveBeenCalled();
  });
});
