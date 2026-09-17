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

import { getPaginatedCosmeticShopItems } from '../cosmetic-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

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
