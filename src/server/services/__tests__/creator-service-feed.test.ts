import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { getServiceOfferingFeed } from '~/server/services/creator-service.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

const blocks = vi.hoisted(() => ({ getBlockedPairIds: vi.fn(async (): Promise<number[]> => []) }));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  ...blocks,
}));

/**
 * The cross-seller services feed against a fixture table: `findMany` applies the `where` the feed
 * sends the way Postgres would, so a gate the feed drops lets a row through.
 */

type Row = {
  id: number;
  status: ServiceOfferingStatus;
  maxNsfwLevel: number;
  price: number;
  maxOpenDeals: number | null;
  sellerId: number;
  seller: {
    bannedAt: Date | null;
    deletedAt: Date | null;
    muted: boolean;
    settings: Record<string, unknown>;
  };
};

// The operators the feed's `where` uses. Anything else throws, so a new clause can't pass unread.
function matches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object' || filter instanceof Date)
    return value === filter;
  return Object.entries(filter as Record<string, unknown>).every(([key, arg]) => {
    switch (key) {
      case 'OR':
        return (arg as unknown[]).some((clause) => matches(value, clause));
      case 'lte':
        return (value as number) <= (arg as number);
      case 'in':
        return (arg as unknown[]).includes(value);
      case 'notIn':
        return !(arg as unknown[]).includes(value);
      case 'path': {
        const { equals } = filter as { equals: unknown };
        const at = (arg as string[]).reduce<unknown>(
          (obj, step) => (obj as Record<string, unknown> | undefined)?.[step],
          value
        );
        return at === equals;
      }
      case 'equals':
        return 'path' in (filter as object) || value === arg;
      default:
        if (typeof value !== 'object' || value === null) throw new Error(`unread operator ${key}`);
        return matches((value as Record<string, unknown>)[key], arg);
    }
  });
}

const SELLER = 7;
const VISITOR = 99;
let nextId = 1;
const row = (patch: Partial<Omit<Row, 'seller'>> & { seller?: Partial<Row['seller']> } = {}) => {
  const { seller, ...rest } = patch;
  return {
    id: nextId++,
    status: ServiceOfferingStatus.Active,
    maxNsfwLevel: NsfwLevel.PG13,
    price: 1000,
    maxOpenDeals: null,
    sellerId: SELLER,
    ...rest,
    seller: {
      bannedAt: null,
      deletedAt: null,
      muted: false,
      settings: { creatorShop: { enabled: true } },
      ...seller,
    },
  } satisfies Row;
};

let table: Row[] = [];
const feedIds = async (
  opts: { browsingLevel?: number; servable?: number; viewerId?: number } = {}
) => {
  const { items } = await getServiceOfferingFeed({
    sort: 'newest',
    limit: 50,
    servable: allBrowsingLevelsFlag,
    viewerId: VISITOR,
    ...opts,
  });
  return items.map((item) => item.id);
};

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  dbMock.dbRead.serviceOffering.findMany.mockImplementation((async (args: {
    where: unknown;
    take: number;
  }) => table.filter((r) => matches(r, args.where)).slice(0, args.take)) as never);
});

describe('services feed', () => {
  it('hides an X-rated offering from an SFW viewer and shows it to one who browses X', async () => {
    const pg13 = row();
    const x = row({ maxNsfwLevel: NsfwLevel.X });
    table = [pg13, x];
    // Signed out: no level, so nothing mature.
    expect(await feedIds({ viewerId: undefined })).toEqual([pg13.id]);
    expect(await feedIds({ browsingLevel: sfwBrowsingLevelsFlag })).toEqual([pg13.id]);
    expect(await feedIds({ browsingLevel: allBrowsingLevelsFlag })).toEqual([pg13.id, x.id]);
    // A domain that serves nothing mature hides it whatever the viewer browses at.
    expect(
      await feedIds({ browsingLevel: allBrowsingLevelsFlag, servable: sfwBrowsingLevelsFlag })
    ).toEqual([pg13.id]);
  });

  it('hides paused, draft and removed offerings', async () => {
    const active = row();
    table = [
      active,
      row({ status: ServiceOfferingStatus.Paused }),
      row({ status: ServiceOfferingStatus.Draft }),
      row({ status: ServiceOfferingStatus.Removed }),
    ];
    expect(await feedIds()).toEqual([active.id]);
  });

  it('hides offerings of banned, muted and deleted sellers', async () => {
    const good = row();
    table = [
      good,
      row({ seller: { bannedAt: new Date() } }),
      row({ seller: { muted: true } }),
      row({ seller: { deletedAt: new Date() } }),
    ];
    expect(await feedIds()).toEqual([good.id]);
  });

  it("hides a seller whose shop isn't published, and one in a block with the viewer", async () => {
    const shown = row();
    const blocked = row({ sellerId: 8 });
    table = [
      shown,
      blocked,
      row({ sellerId: 9, seller: { settings: { creatorShop: { enabled: false } } } }),
      row({ sellerId: 10, seller: { settings: {} } }),
    ];
    blocks.getBlockedPairIds.mockResolvedValue([8]);
    expect(await feedIds()).toEqual([shown.id]);
    expect(blocks.getBlockedPairIds).toHaveBeenCalledWith(VISITOR);
  });

  it('returns a cursor only when another page exists', async () => {
    table = [row(), row(), row()];
    const page = (limit: number) =>
      getServiceOfferingFeed({ sort: 'newest', limit, servable: allBrowsingLevelsFlag });
    const first = await page(2);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1].id);
    expect((await page(3)).nextCursor).toBeUndefined();
  });
});
