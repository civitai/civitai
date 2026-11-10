/**
 * Knights of New Order sells its own cosmetics and grants its badges as Trophies; listing one in the main
 * shop would sell what Knights reserves, so the shop editor refuses those cosmetics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs: vi.fn(async ({ html }: { html: string }) => ({ evaluated: false, html, uses: [] })),
  getReferencedBlurbIds: vi.fn(async () => []),
  reconcileBlurbReferences: vi.fn(async () => undefined),
}));

import { upsertCosmeticShopItem } from '~/server/services/cosmetic-shop.service';

const create = vi.fn(async () => ({ id: 1, cosmeticId: 7 }));

const list = () =>
  upsertCosmeticShopItem({
    userId: 99,
    isModerator: true,
    title: 'Golden Laurel',
    unitAmount: 500,
    cosmeticId: 7,
  } as never);

beforeEach(() => {
  create.mockClear();
  dbMock.dbWrite.cosmetic.findUnique.mockResolvedValue({ source: 'Purchase' } as never);
  dbMock.dbWrite.knightsShopItem.findFirst.mockResolvedValue(null as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({ cosmeticShopItem: { create } })) as never);
});

describe('listing a cosmetic in the main shop', () => {
  it('lists an ordinary cosmetic', async () => {
    await list();
    expect(create).toHaveBeenCalled();
  });

  it('refuses a cosmetic the Knights shop sells', async () => {
    dbMock.dbWrite.knightsShopItem.findFirst.mockResolvedValue({ id: 3 } as never);
    await expect(list()).rejects.toThrow(/Knights of New Order/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a Trophy cosmetic', async () => {
    dbMock.dbWrite.cosmetic.findUnique.mockResolvedValue({ source: 'Trophy' } as never);
    await expect(list()).rejects.toThrow(/Knights of New Order/);
    expect(create).not.toHaveBeenCalled();
  });
});
