import type * as MysteryBoxService from '~/server/services/mystery-box.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The reads behind a creator's pack storefront and manage view: nothing for a viewer without the
// creator pack flag, nothing in a hidden region, and a creator's packs only to the creator or a mod.

const mocks = vi.hoisted(() => ({
  hidden: vi.fn(),
  listings: vi.fn(),
  tiers: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock('~/server/services/mystery-box.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxService>()),
  mysteryBoxesHiddenIn: mocks.hidden,
  readBoxListings: mocks.listings,
  getBoxTiers: mocks.tiers,
  getBoxCatalogForDisplay: mocks.catalog,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
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

beforeEach(() => {
  mocks.hidden.mockReset().mockResolvedValue(false);
  mocks.listings.mockReset().mockResolvedValue({ onSale: () => ({ unitAmount: 700 }) });
  mocks.tiers.mockReset().mockResolvedValue([
    {
      boxDefinitionId: 9,
      id: 1,
      key: 'common',
      name: 'Common',
      color: null,
      weight: 8000,
      sortOrder: 0,
    },
    {
      boxDefinitionId: 9,
      id: 2,
      key: 'rare',
      name: 'Rare',
      color: null,
      weight: 2000,
      sortOrder: 1,
    },
  ]);
  mocks.catalog.mockReset().mockResolvedValue([
    { contentId: 1, tierId: 1 },
    { contentId: 2, tierId: 2 },
  ]);
  dbMock.dbRead.itemDefinition.findMany.mockReset().mockResolvedValue([BOX]);
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
          status: 'published',
          sellerId: 77,
          seller: { bannedAt: null, deletedAt: null },
        }),
      })
    );
  });

  it('leaves out a pack with nothing on sale', async () => {
    mocks.listings.mockResolvedValue({ onSale: () => undefined });
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
    expect(dbMock.dbWrite.itemDefinition.findMany).toHaveBeenCalledTimes(2);
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
  });
});

describe('getMysteryPackViewsForSeller', () => {
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
