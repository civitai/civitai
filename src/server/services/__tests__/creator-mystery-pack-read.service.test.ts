import type * as MysteryBoxService from '~/server/services/mystery-box.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hidden: vi.fn(),
  held: vi.fn(),
}));

vi.mock('~/server/services/mystery-box.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxService>()),
  mysteryBoxesHiddenIn: mocks.hidden,
}));
vi.mock('~/server/services/item.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listHeldItems: mocks.held,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { clearBoxCatalogDisplayCache } from '~/server/services/mystery-box.service';
import {
  clearCommunityPacksCache,
  getCreatorMysteryPacks,
  getMyMysteryPacks,
  getMysteryPackViewsForSeller,
  getMysteryPackCandidates,
} from '~/server/services/creator-mystery-pack-read.service';

const BOX = {
  id: 9,
  name: 'Neon Night Pack',
  description: null,
  version: 2,
  status: 'published',
  params: {},
  seller: { id: 77, username: 'testcreator' },
};

type Tier = {
  boxDefinitionId: number;
  id: number;
  key: string;
  name: string;
  color: string | null;
  weight: number;
  sortOrder: number;
};
const tier = (boxDefinitionId: number, id: number, key: string, sortOrder: number): Tier => ({
  boxDefinitionId,
  id,
  key,
  name: key,
  color: null,
  weight: 1000,
  sortOrder,
});
const listing = (itemDefinitionId: number) => ({
  id: 5,
  itemDefinitionId,
  title: 'T',
  unitAmount: 700,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  meta: null,
});
const content = (id: number, tierId: number) => ({
  id,
  tierId,
  rewardDefinitionId: 100 + id,
  reward: {
    type: 'cosmetic',
    cosmeticId: 1000 + id,
    cosmetic: { name: `Item ${id}`, data: { url: `${id}.png` }, type: 'ContentDecoration' },
  },
});

// The database the shared box readers query, so each caller runs the real listing, tier and
// held-box rules.
let world: { listings: ReturnType<typeof listing>[]; tiers: Tier[] };

beforeEach(() => {
  clearCommunityPacksCache();
  clearBoxCatalogDisplayCache();
  mocks.hidden.mockReset().mockResolvedValue(false);
  world = {
    listings: [listing(BOX.id)],
    tiers: [tier(BOX.id, 1, 'common', 0), tier(BOX.id, 2, 'rare', 1)],
  };
  const db = dbMock.dbRead;
  const inIds = (filter: { in: number[] }, id: number) => filter.in.includes(id);
  db.cosmeticShopItem.findMany
    .mockReset()
    .mockImplementation(async ({ where }: { where: { itemDefinitionId: { in: number[] } } }) =>
      world.listings.filter((l) => inIds(where.itemDefinitionId, l.itemDefinitionId))
    );
  db.boxTier.findMany
    .mockReset()
    .mockImplementation(async ({ where }: { where: { boxDefinitionId: { in: number[] } } }) =>
      world.tiers.filter((t) => inIds(where.boxDefinitionId, t.boxDefinitionId))
    );
  db.boxContent.findMany.mockReset().mockResolvedValue([content(1, 1), content(2, 2)]);
  db.userCosmetic.findMany.mockReset().mockResolvedValue([]);
  db.boxOpening.findMany.mockReset().mockResolvedValue([]);
  mocks.held.mockReset().mockResolvedValue([]);
  db.itemDefinition.findMany.mockReset().mockResolvedValue([BOX]);
});

describe('getCreatorMysteryPacks', () => {
  const read = (overrides: Partial<Parameters<typeof getCreatorMysteryPacks>[0]> = {}) =>
    getCreatorMysteryPacks({ enabled: true, countryCode: 'US', ...overrides });

  it('lists a live pack with its seller, price and tiers', async () => {
    expect(await read({ sellerId: 77 })).toEqual([
      expect.objectContaining({
        boxDefinitionId: 9,
        unitAmount: 700,
        seller: { id: 77, username: 'testcreator' },
        teams: [],
        contents: [
          { contentId: 1, tierId: 1, team: null },
          { contentId: 2, tierId: 2, team: null },
        ],
      }),
    ]);
  });

  it('returns nothing, and reads nothing, for a viewer without the creator pack flag', async () => {
    expect(await read({ enabled: false })).toEqual([]);
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });

  it('returns nothing in a hidden region', async () => {
    mocks.hidden.mockResolvedValue(true);
    expect(await read()).toEqual([]);
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });

  it('asks only for published packs of a seller who is neither banned nor deleted', async () => {
    await read({ sellerId: 77 });
    expect(dbMock.dbRead.itemDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['published'] },
          sellerId: 77,
          seller: { bannedAt: null, deletedAt: null },
        }),
      })
    );
  });

  it("lists every seller's packs for the community shop, and only seller boxes", async () => {
    await read();
    expect(dbMock.dbRead.itemDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sellerId: { not: null } }),
      })
    );
  });

  it('shares one read between concurrent community views', async () => {
    await Promise.all([read(), read(), read()]);
    expect(dbMock.dbRead.itemDefinition.findMany).toHaveBeenCalledTimes(1);
  });

  it('gives each pack only its own tiers', async () => {
    dbMock.dbRead.itemDefinition.findMany.mockResolvedValue([
      BOX,
      { ...BOX, id: 10, name: 'Other', seller: { id: 78, username: 'other' } },
    ]);
    world.listings = [listing(9), listing(10)];
    world.tiers = [tier(9, 1, 'common', 0), tier(10, 5, 'common', 0)];
    const packs = await read();
    expect(packs.map((p) => [p.boxDefinitionId, p.tiers.map((t) => t.id)])).toEqual([
      [9, [1]],
      [10, [5]],
    ]);
  });

  it('leaves out a pack with nothing on sale', async () => {
    world.listings = [];
    expect(await read()).toEqual([]);
  });
});

describe('getMyMysteryPacks', () => {
  beforeEach(() => {
    dbMock.dbWrite.itemDefinition.findMany.mockReset().mockResolvedValue([]);
  });

  it("refuses another creator's packs, and reads nothing", async () => {
    await expect(
      getMyMysteryPacks({ ownerId: 77, viewer: { id: 5, isModerator: false } })
    ).rejects.toThrow(/another creator/);
    expect(dbMock.dbWrite.itemDefinition.findMany).not.toHaveBeenCalled();
  });

  it('shows a creator their own, and a moderator anyone', async () => {
    await getMyMysteryPacks({ ownerId: 77, viewer: { id: 77 } });
    await getMyMysteryPacks({ ownerId: 77, viewer: { id: 5, isModerator: true } });
    const calls = dbMock.dbWrite.itemDefinition.findMany.mock.calls;
    expect(calls.map(([q]) => q.where.sellerId)).toEqual([77, 77]);
  });

  it('opens an edit on the pending revision, else the last approved version', async () => {
    const proposal = (price: number) => ({ steepness: 'standard', tiers: [], price });
    dbMock.dbWrite.itemDefinition.findMany.mockResolvedValue([
      {
        id: 9,
        name: 'P',
        description: null,
        version: 2,
        status: 'published',
        shopItems: [{ id: 1, status: 'Published', unitAmount: 700 }],
        revisions: [
          { id: 3, status: 'pending', baseVersion: 2, proposal: proposal(650), note: null },
          { id: 2, status: 'approved', baseVersion: 1, proposal: proposal(700), note: null },
        ],
      },
    ]);
    const [pack] = await getMyMysteryPacks({ ownerId: 77, viewer: { id: 77 } });
    expect(pack.pending?.id).toBe(3);
    expect(pack.proposal?.price).toBe(650);
    expect(pack.rejection).toBeNull();
    expect(pack.listing).toEqual({ id: 1, status: 'Published', unitAmount: 700 });
  });

  it('opens an edit of a live pack at its current price, which a lowered price may have changed', async () => {
    dbMock.dbWrite.itemDefinition.findMany.mockResolvedValue([
      {
        id: 9,
        name: 'P',
        description: null,
        version: 2,
        status: 'published',
        shopItems: [{ id: 1, status: 'Published', unitAmount: 600 }],
        revisions: [
          {
            id: 2,
            status: 'approved',
            baseVersion: 1,
            proposal: { steepness: 'standard', tiers: [], price: 700 },
            note: null,
          },
        ],
      },
    ]);
    const [pack] = await getMyMysteryPacks({ ownerId: 77, viewer: { id: 77 } });
    expect(pack.proposal?.price).toBe(600);
  });

  it("shows the reviewer's note on a rejected newest edit, until a newer edit replaces it", async () => {
    const rev = (id: number, status: string, note: string | null) => ({
      id,
      status,
      baseVersion: 1,
      proposal: { steepness: 'standard', tiers: [], price: 700 },
      note,
    });
    const box = (revisions: unknown[]) => [
      {
        id: 9,
        name: 'P',
        description: null,
        version: 1,
        status: 'draft',
        shopItems: [],
        revisions,
      },
    ];
    dbMock.dbWrite.itemDefinition.findMany.mockResolvedValue(
      box([rev(4, 'rejected', 'Too pricey')])
    );
    expect((await getMyMysteryPacks({ ownerId: 77, viewer: { id: 77 } }))[0].rejection).toBe(
      'Too pricey'
    );
    dbMock.dbWrite.itemDefinition.findMany.mockResolvedValue(
      box([rev(5, 'pending', null), rev(4, 'rejected', 'Too pricey')])
    );
    expect((await getMyMysteryPacks({ ownerId: 77, viewer: { id: 77 } }))[0].rejection).toBeNull();
  });
});

describe('getMysteryPackViewsForSeller', () => {
  it('shows a pack on sale and a held one off sale, not an unsold draft, with its seller', async () => {
    const seller = { id: 77, username: 'testcreator' };
    const box = (id: number, status: string) => ({ ...BOX, id, status, seller });
    dbMock.dbRead.itemDefinition.findMany.mockResolvedValue([
      box(1, 'published'),
      box(2, 'archived'),
      box(3, 'draft'),
    ]);
    world.listings = [listing(1)];
    mocks.held.mockResolvedValue([{ id: BigInt(99), itemDefinitionId: 2 }]);
    const views = await getMysteryPackViewsForSeller({
      sellerId: 77,
      userId: 5,
      enabled: true,
      countryCode: 'US',
    });
    expect(views).toEqual([
      expect.objectContaining({ boxDefinitionId: 1, seller, listing: expect.anything() }),
      expect.objectContaining({
        boxDefinitionId: 2,
        seller,
        listing: null,
        heldBoxItemIds: ['99'],
      }),
    ]);
  });

  it('returns nothing, and reads nothing, without the creator pack flag or in a hidden region', async () => {
    const read = (enabled: boolean) =>
      getMysteryPackViewsForSeller({ sellerId: 77, userId: 5, enabled, countryCode: 'US' });
    expect(await read(false)).toEqual([]);
    mocks.hidden.mockResolvedValue(true);
    expect(await read(true)).toEqual([]);
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });
});

describe('getMysteryPackCandidates', () => {
  const row = (overrides: Record<string, unknown>) => ({
    cosmeticId: 1,
    name: 'Neon frame',
    type: 'ProfileDecoration',
    createdById: 77,
    data: {},
    addedById: 77,
    status: 'Published',
    archivedAt: null,
    availableQuantity: null,
    availableFrom: null,
    availableTo: null,
    listed: true,
    unitAmount: 800,
    ...overrides,
  });

  it('values an eligible item at its shelf price and gives the refusal of an ineligible one', async () => {
    dbMock.dbWrite.$queryRaw
      .mockReset()
      .mockResolvedValue([row({}), row({ cosmeticId: 2, name: 'Limited', availableQuantity: 10 })]);
    const [ok, limited] = await getMysteryPackCandidates({ creatorId: 77, stickersEnabled: false });
    expect(ok).toMatchObject({ cosmeticId: 1, value: 800, problem: null });
    expect(limited).toMatchObject({ cosmeticId: 2, value: null });
    expect(limited.problem).toMatch(/limited stock/);
  });

  it('counts a box-only item at the floor, not at the price its creator typed', async () => {
    dbMock.dbWrite.$queryRaw
      .mockReset()
      .mockResolvedValue([row({ listed: false, unitAmount: 50000 })]);
    const [item] = await getMysteryPackCandidates({ creatorId: 77, stickersEnabled: false });
    expect(item.value).toBe(500);
  });
});
