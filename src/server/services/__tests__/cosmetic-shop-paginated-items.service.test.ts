import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(),
}));
// `importOriginal` keeps the rest real — this module's import graph reaches prom
// collectors it never names.
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));

import { getPaginatedCosmeticShopItems, getShopItemById } from '../cosmetic-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { soldCountsFake } from '~/test-utils/soldCountsFake';

const capturedWhere = () =>
  dbMock.dbRead.cosmeticShopItem.findMany.mock.calls[0][0].where as Record<string, unknown>;

describe('getPaginatedCosmeticShopItems archived filter', () => {
  beforeEach(() => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockReset();
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([]);
    dbMock.dbRead.cosmeticShopItem.count.mockReset();
    dbMock.dbRead.cosmeticShopItem.count.mockResolvedValue(0);
  });

  it('drops archived listings when archived is false (the section-items picker)', async () => {
    await getPaginatedCosmeticShopItems({ archived: false, page: 1, limit: 60 });

    const where = capturedWhere();
    expect(where.archivedAt).toBeNull();
    expect(where.status).toEqual({ not: 'Archived' });
  });

  it('shows only archived listings when archived is true', async () => {
    await getPaginatedCosmeticShopItems({ archived: true, page: 1, limit: 60 });

    const where = capturedWhere();
    expect(where.archivedAt).toEqual({ not: null });
  });

  it('leaves archived listings in by default (the moderator store management list)', async () => {
    await getPaginatedCosmeticShopItems({ page: 1, limit: 60 });

    const where = capturedWhere();
    expect(where.archivedAt).toBeUndefined();
    expect(where.status).toBeUndefined();
  });

  it('resellable + archived:false keeps the stricter Published status and still excludes archived', async () => {
    await getPaginatedCosmeticShopItems({
      archived: false,
      resellable: true,
      page: 1,
      limit: 60,
    });

    const where = capturedWhere();
    expect(where.status).toBe('Published');
    expect(where.archivedAt).toBeNull();
  });
});

/**
 * Both of these return `meta` to the client as-is, so the row count is written
 * onto `meta.purchases` by `withSoldCounts` rather than by a whitelist. Nothing
 * else executes those two call sites: removing either mapping leaves every other
 * suite green.
 *
 * TO WHOEVER IS ABOUT TO DELETE THIS: the helper's own unit tests do not cover
 * its wiring, which is the half that was missing the first time round.
 */
describe('the unsanitized read paths serve the row count', () => {
  const drifted = {
    id: 74,
    title: 'Fairy Pony',
    meta: { purchases: 0 },
  };

  beforeEach(() => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockReset();
    dbMock.dbRead.cosmeticShopItem.count.mockReset();
    dbMock.dbRead.cosmeticShopItem.count.mockResolvedValue(1);
    dbMock.dbRead.cosmeticShopItem.findUniqueOrThrow.mockReset();
    dbMock.dbWrite.cosmeticShopItem.findUniqueOrThrow.mockReset();
    dbMock.dbRead.$queryRaw.mockImplementation(soldCountsFake({ 74: 20 }));
  });

  it('getPaginatedCosmeticShopItems reports the rows, not the counter', async () => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([drifted]);

    const { items } = await getPaginatedCosmeticShopItems({ page: 1, limit: 60 });

    expect(items[0].meta.purchases).toBe(20);
  });

  it('getShopItemById reports the rows, not the counter', async () => {
    dbMock.dbRead.cosmeticShopItem.findUniqueOrThrow.mockResolvedValue(drifted);

    expect((await getShopItemById({ id: 74 })).meta.purchases).toBe(20);
  });

  // The mapping sits AFTER the `.catch`, so the replica-fallback result is
  // mapped too. Inside the catch it would not be, and nothing else would say so.
  it('maps the writer-fallback result as well as the replica one', async () => {
    dbMock.dbRead.cosmeticShopItem.findUniqueOrThrow.mockRejectedValue(new Error('replica down'));
    dbMock.dbWrite.cosmeticShopItem.findUniqueOrThrow.mockResolvedValue(drifted);

    expect((await getShopItemById({ id: 74 })).meta.purchases).toBe(20);
  });
});
