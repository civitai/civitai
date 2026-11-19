import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type { Tracker } from '~/server/clickhouse/client';

const { chQuery } = vi.hoisted(() => ({ chQuery: vi.fn() }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clickhouse: { $query: chQuery },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));

import {
  addShopItemToSection,
  deleteCosmeticShopSection,
  getPaginatedCosmeticShopItems,
  removeShopItemFromSection,
  upsertCosmeticShopSection,
} from '../cosmetic-shop.service';
import { getShopItemsFeaturedHistory } from '../cosmetic-shop-featured-log.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const entityChanges = vi.fn();
const tracker = { entityChanges } as unknown as Tracker;

const loggedRows = () => entityChanges.mock.calls.flatMap(([rows]) => rows);
const summary = () =>
  loggedRows().map((r: { entityId: number; oldValue: string; newValue: string }) => ({
    id: r.entityId,
    from: r.oldValue,
    to: r.newValue,
  }));

beforeEach(() => {
  entityChanges.mockReset().mockResolvedValue(undefined);
  chQuery.mockReset().mockResolvedValue([]);
  dbMock.dbWrite.cosmeticShopItem.count.mockResolvedValue(0);
  dbMock.dbWrite.cosmeticShopItem.findMany.mockResolvedValue([]);
  dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([
    { id: 1, cosmetic: { createdById: 42 } },
    { id: 3, cosmetic: null },
  ]);
  dbMock.dbRead.cosmeticShopSection.findUniqueOrThrow.mockResolvedValue({ id: 5, items: [] });
});

describe('section saves record what was featured', () => {
  it('the editor logs the items it added and removed, not the ones it kept', async () => {
    dbMock.dbWrite.cosmeticShopSectionItem.findMany.mockResolvedValueOnce([
      { shopItemId: 1 },
      { shopItemId: 2 },
    ]);

    await upsertCosmeticShopSection({ id: 5, title: 'Picks', items: [2, 3], userId: 1, tracker });

    expect(summary()).toEqual([
      { id: 3, from: '', to: '5' },
      { id: 1, from: '5', to: '' },
    ]);
    const [added, removed] = loggedRows();
    expect(added).toMatchObject({
      entityType: 'CosmeticShopItem',
      field: 'shopSection',
      ownerId: -1,
      actorRole: 'moderator',
    });
    expect(removed.ownerId).toBe(42);
    expect(added.batchId).toBe(removed.batchId);
  });

  it('a failing audit write does not fail a save that already landed', async () => {
    dbMock.dbWrite.cosmeticShopSectionItem.findMany.mockResolvedValueOnce([]);
    dbMock.dbRead.cosmeticShopItem.findMany.mockRejectedValueOnce(new Error('replica down'));

    await expect(
      upsertCosmeticShopSection({ id: 5, title: 'Picks', items: [3], userId: 1, tracker })
    ).resolves.toBeDefined();
  });

  it('a save that leaves the items alone logs nothing', async () => {
    dbMock.dbWrite.cosmeticShopSectionItem.findMany.mockResolvedValueOnce([{ shopItemId: 2 }]);

    await upsertCosmeticShopSection({ id: 5, title: 'Picks', items: [2], userId: 1, tracker });

    expect(entityChanges).not.toHaveBeenCalled();
  });

  it('the review drawer logs an add only when the row was new', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
      status: 'Published',
      archivedAt: null,
    });
    dbMock.dbWrite.cosmeticShopSectionItem.findMany.mockResolvedValue([]);

    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0);
    await addShopItemToSection({ shopItemId: 3, sectionId: 5, tracker });
    expect(entityChanges).not.toHaveBeenCalled();

    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(1);
    await addShopItemToSection({ shopItemId: 3, sectionId: 5, tracker });
    expect(summary()).toEqual([{ id: 3, from: '', to: '5' }]);
  });

  it('the review drawer logs a removal', async () => {
    dbMock.dbWrite.cosmeticShopSectionItem.deleteMany.mockResolvedValueOnce({ count: 1 });
    dbMock.dbWrite.cosmeticShopSectionItem.findMany.mockResolvedValue([]);

    await removeShopItemFromSection({ shopItemId: 1, sectionId: 5, tracker });

    expect(summary()).toEqual([{ id: 1, from: '5', to: '' }]);
  });

  it('deleting a section logs every item it held as removed', async () => {
    dbMock.dbWrite.cosmeticShopSectionItem.findMany.mockResolvedValueOnce([
      { shopItemId: 1 },
      { shopItemId: 3 },
    ]);
    dbMock.dbWrite.cosmeticShopSection.delete.mockResolvedValueOnce({ id: 5 });

    await deleteCosmeticShopSection({ id: 5, tracker });

    expect(summary()).toEqual([
      { id: 1, from: '5', to: '' },
      { id: 3, from: '5', to: '' },
    ]);
  });
});

describe('the picker reads featured history', () => {
  it('merges current sections with the last logged add', async () => {
    dbMock.dbRead.cosmeticShopSectionItem.findMany.mockResolvedValueOnce([
      { shopItemId: 1, shopSection: { id: 5, title: 'Picks' } },
    ]);
    chQuery.mockResolvedValueOnce([{ entityId: '3', at: '1762450000000' }]);

    const history = await getShopItemsFeaturedHistory({ ids: [1, 3, 9] });

    expect(history).toEqual({
      1: { lastFeaturedAt: null, currentSections: [{ id: 5, title: 'Picks' }] },
      3: { lastFeaturedAt: 1762450000000, currentSections: [] },
      9: { lastFeaturedAt: null, currentSections: [] },
    });
    const sql = (chQuery.mock.calls[0][0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain("entityType = 'CosmeticShopItem' AND entityId IN (1,3,9)");
    expect(sql).toContain("field = 'shopSection' AND newValue != ''");
  });
});

describe('the published-creator picker lists newest approved first', () => {
  beforeEach(() => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([]);
    dbMock.dbRead.cosmeticShopItem.count.mockResolvedValue(0);
  });

  it('orders by reviewedAt, unreviewed last', async () => {
    await getPaginatedCosmeticShopItems({ limit: 20, page: 2, publishedCreatorOnly: true });

    expect(dbMock.dbRead.cosmeticShopItem.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        orderBy: [{ reviewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: 20,
        take: 20,
      })
    );
  });

  it('other lists keep newest submitted first (control)', async () => {
    await getPaginatedCosmeticShopItems({ limit: 20, page: 1 });

    expect(dbMock.dbRead.cosmeticShopItem.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } })
    );
  });
});
