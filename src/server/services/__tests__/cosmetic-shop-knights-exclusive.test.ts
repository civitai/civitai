/**
 * Knights of New Order grants its badges as Trophies and sells some cosmetics only in its own shop;
 * the main shop editor refuses those. Creator cosmetics Knights also sells stay listable here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
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

type Row = Record<string, unknown>;

const ORDINARY = 1;
const KNIGHTS_EXCLUSIVE = 2;
const KNIGHTS_CREATOR = 3;
const TROPHY = 4;
const RETIRED_KNIGHTS_EXCLUSIVE = 5;

// Fakes answer by the query's `where` and project its `select`, so a guard that asks the wrong
// question gets the wrong answer instead of a canned one.
const cosmetics: Record<number, Row> = {
  [ORDINARY]: { id: ORDINARY, source: 'Purchase', createdById: null },
  [KNIGHTS_EXCLUSIVE]: { id: KNIGHTS_EXCLUSIVE, source: 'Purchase', createdById: null },
  [KNIGHTS_CREATOR]: { id: KNIGHTS_CREATOR, source: 'Purchase', createdById: 42 },
  [TROPHY]: { id: TROPHY, source: 'Trophy', createdById: null },
  [RETIRED_KNIGHTS_EXCLUSIVE]: {
    id: RETIRED_KNIGHTS_EXCLUSIVE,
    source: 'Purchase',
    createdById: null,
  },
};
const knightsShopItems: Row[] = [
  { id: 10, cosmeticId: KNIGHTS_EXCLUSIVE, active: true },
  { id: 11, cosmeticId: KNIGHTS_CREATOR, active: true },
  { id: 12, cosmeticId: RETIRED_KNIGHTS_EXCLUSIVE, active: false },
];

const project = (row: Row | undefined, select?: Record<string, boolean>) => {
  if (!row) return null;
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
};
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

const create = vi.fn(async () => ({ id: 1, cosmeticId: ORDINARY }));
const update = vi.fn(async () => ({ id: 50, cosmeticId: KNIGHTS_EXCLUSIVE }));

const list = (cosmeticId: number) =>
  upsertCosmeticShopItem({
    userId: 99,
    isModerator: true,
    title: 'Golden Laurel',
    unitAmount: 500,
    cosmeticId,
  } as never);

const edit = (cosmeticId: number) =>
  upsertCosmeticShopItem({
    id: 50,
    userId: 99,
    isModerator: true,
    title: 'Golden Laurel',
    unitAmount: 500,
    cosmeticId,
  } as never);

beforeEach(() => {
  resetHybridNodes();
  create.mockClear();
  update.mockClear();
  dbMock.dbWrite.cosmetic.findUnique.mockImplementation((async (args: {
    where: { id: number };
    select?: Record<string, boolean>;
  }) => project(cosmetics[args.where.id], args.select)) as never);
  dbMock.dbWrite.knightsShopItem.findFirst.mockImplementation((async (args: {
    where?: Row;
    select?: Record<string, boolean>;
  }) =>
    project(
      knightsShopItems.find((row) => matches(row, args.where)),
      args.select
    )) as never);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
    id: 50,
    cosmeticId: KNIGHTS_EXCLUSIVE,
    addedById: 99,
    _count: { purchases: 0 },
  } as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: vi.fn(async () => []),
      cosmeticShopItem: {
        create,
        update,
        findUnique: vi.fn(async () => ({
          status: 'Approved',
          meta: {},
          unitAmount: 500,
          title: 'Golden Laurel',
          description: null,
          availableQuantity: null,
        })),
      },
    })) as never);
});

describe('listing a cosmetic in the main shop', () => {
  it('lists an ordinary cosmetic', async () => {
    await list(ORDINARY);
    expect(create).toHaveBeenCalled();
  });

  it('refuses a cosmetic only the Knights shop sells', async () => {
    await expect(list(KNIGHTS_EXCLUSIVE)).rejects.toThrow(/Knights of New Order/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a Knights-exclusive cosmetic whose Knights listing is retired', async () => {
    await expect(list(RETIRED_KNIGHTS_EXCLUSIVE)).rejects.toThrow(/Knights of New Order/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('lists a creator cosmetic the Knights shop also sells', async () => {
    await list(KNIGHTS_CREATOR);
    expect(create).toHaveBeenCalled();
  });

  it('refuses a Trophy cosmetic', async () => {
    await expect(list(TROPHY)).rejects.toThrow(/Knights of New Order/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });
});

describe('editing a main-shop listing', () => {
  it('saves an edit that keeps the listing’s cosmetic without re-checking it', async () => {
    await edit(KNIGHTS_EXCLUSIVE);
    expect(dbMock.dbWrite.cosmetic.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.knightsShopItem.findFirst).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });

  it('refuses switching a listing to a Knights-exclusive cosmetic', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
      id: 50,
      cosmeticId: ORDINARY,
      addedById: 99,
      _count: { purchases: 0 },
    } as never);
    await expect(edit(KNIGHTS_EXCLUSIVE)).rejects.toThrow(/Knights of New Order/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });
});
