import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
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
// `getPlacementConfig`'s KeyValue read, through Kysely: no stored row, so the compiled defaults
// apply.
const { placementConfigRow } = vi.hoisted(() => ({
  placementConfigRow: vi.fn(async () => undefined),
}));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getKeyValue: placementConfigRow,
}));
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

// The host image read runs through Kysely, not Prisma's `$queryRaw`: it gets the same one row (see
// beforeEach). The hosts-with-entries lookup in front of the has-entries probe finds no placement.
const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);
const ONE_ROW = [{ score: 0, exists: false, count: 0, nsfwLevel: 1, minor: false, showable: true }];

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
  dbMock.dbRead.$queryRaw.mockResolvedValue(ONE_ROW);
  kysely.read
    .mockReset()
    .mockImplementation(async (strings: readonly string[]) =>
      strings.join('?').includes('SELECT DISTINCT pl."targetId" AS "hostId"') ? [] : ONE_ROW
    );
});

// Prisma's raw reads answered an id past int4 with no rows; through the pg pools the same
// statements are a range error. The host image read and the has-entries probe skip it instead.
describe('a host id past int4', () => {
  it('still answers, without binding the id in any Kysely read', async () => {
    const { rejectPastInt4 } = await import('~/test-utils/kysely-raw-fake');
    hostOwnedBy('host-owner');
    kysely.read.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
      rejectPastInt4(values);
      return strings.join('?').includes('SELECT DISTINCT pl."targetId" AS "hostId"') ? [] : ONE_ROW;
    });

    await expect(
      getRemixGalleryVisibility({
        hostImageId: 2 ** 31,
        browsingLevel: allBrowsingLevelsFlag,
        domainLevels: allBrowsingLevelsFlag,
      })
    ).resolves.toMatchObject({ ownerId: OWNER, hasEntries: false });
    expect(kysely.read).not.toHaveBeenCalled();
  });
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
