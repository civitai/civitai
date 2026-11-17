import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { getServiceOfferingFeedSchema } from '~/server/schema/creator-service.schema';
import { getServiceOfferingFeed } from '~/server/services/creator-service.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  ImageIngestionStatus,
  ServiceOfferingIngestionStatus,
  ServiceOfferingStatus,
} from '~/shared/utils/prisma/enums';

/**
 * The cross-seller services feed against a fixture table: `findMany` applies the `where`,
 * `orderBy`, `cursor`, `skip` and `take` the feed sends the way Prisma would, so a gate the feed
 * drops lets a row through and a paging slip repeats or skips one.
 */

type Row = {
  id: number;
  title: string;
  description: string;
  status: ServiceOfferingStatus;
  maxNsfwLevel: number;
  price: number;
  maxOpenDeals: number | null;
  createdAt: Date;
  sellerId: number;
  ingestion: ServiceOfferingIngestionStatus;
  coverImageId: number | null;
  coverImage: {
    ingestion: ImageIngestionStatus;
    needsReview: string | null;
    tosViolation: boolean;
    nsfwLevel: number;
    modelRestricted?: boolean;
  } | null;
  seller: {
    username: string | null;
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
      case 'AND':
        return (arg as unknown[]).every((clause) => matches(value, clause));
      case 'contains': {
        // As Postgres runs Prisma's `contains`: a LIKE where an unescaped `%` or `_` is a
        // wildcard, case-sensitive unless the clause asks otherwise.
        const flags = (filter as { mode?: string }).mode === 'insensitive' ? 'i' : '';
        const pattern = (arg as string).replace(
          /\\(.)|([%_])|([^\\%_])/g,
          (_, escaped, wild, char) =>
            wild
              ? wild === '%'
                ? '.*'
                : '.'
              : (escaped ?? char).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        );
        return new RegExp(pattern, flags).test(value as string);
      }
      case 'mode':
        return true;
      case 'lte':
        return (value as number) <= (arg as number);
      case 'in':
        return (arg as unknown[]).includes(value);
      case 'notIn':
        return !(arg as unknown[]).includes(value);
      case 'not':
        return !matches(value, arg);
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
        // An absent relation (`coverImage: null`) matches no filter on it.
        if (value === null && key !== 'equals') return false;
        if (typeof value !== 'object' || value === null) throw new Error(`unread operator ${key}`);
        return matches((value as Record<string, unknown>)[key], arg);
    }
  });
}

type OrderBy = Partial<Record<keyof Row, 'asc' | 'desc'>>[];
const compare = (orderBy: OrderBy) => (a: Row, b: Row) => {
  for (const clause of orderBy) {
    const [[field, dir]] = Object.entries(clause) as [keyof Row, 'asc' | 'desc'][];
    const [x, y] = [a[field], b[field]] as [number | Date, number | Date];
    if (+x !== +y) return (+x < +y ? -1 : 1) * (dir === 'asc' ? 1 : -1);
  }
  return 0;
};

const SELLER = 7;
const VISITOR = 99;
let nextId = 1;
const row = (patch: Partial<Omit<Row, 'seller'>> & { seller?: Partial<Row['seller']> } = {}) => {
  const { seller, ...rest } = patch;
  const id = nextId++;
  return {
    id,
    title: `Offering ${id}`,
    description: 'Custom work.',
    status: ServiceOfferingStatus.Active,
    maxNsfwLevel: NsfwLevel.PG13,
    price: 1000,
    maxOpenDeals: null,
    createdAt: new Date(Date.UTC(2026, 10, id)),
    sellerId: SELLER,
    ingestion: ServiceOfferingIngestionStatus.Scanned,
    coverImageId: null,
    coverImage: null,
    ...rest,
    seller: {
      username: 'seller',
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
  opts: { browsingLevel?: number; servable?: number; viewerId?: number; query?: string } = {}
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

const hidden = vi.spyOn(HiddenUsers, 'getCached');
const blockedBy = vi.spyOn(BlockedByUsers, 'getCached');
const blocked = vi.spyOn(BlockedUsers, 'getCached');
const users = (...ids: number[]) => ids.map((id) => ({ id, username: `u${id}` })) as never;

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
  hidden.mockResolvedValue(users());
  blockedBy.mockResolvedValue(users());
  blocked.mockResolvedValue(users());
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  dbMock.dbRead.serviceOffering.findMany.mockImplementation((async (args: {
    where: unknown;
    orderBy: OrderBy;
    cursor?: { id: number };
    skip?: number;
    take: number;
  }) => {
    const sorted = table.filter((r) => matches(r, args.where)).sort(compare(args.orderBy));
    // Prisma pages from the cursor row's position in the ordering, wherever that row is.
    const anchor = args.cursor
      ? [...table].sort(compare(args.orderBy)).find((r) => r.id === args.cursor?.id)
      : undefined;
    const start = anchor ? sorted.filter((r) => compare(args.orderBy)(r, anchor) < 0).length : 0;
    return sorted.slice(start + (args.skip ?? 0), start + (args.skip ?? 0) + args.take);
  }) as never);
});

describe('services feed', () => {
  it("selects the seller with their equipped cosmetics, so the card's avatar shows frame and nameplate", async () => {
    table = [row()];
    await feedIds({});
    const [args] = dbMock.dbRead.serviceOffering.findMany.mock.calls.at(-1) as [
      { select: { seller: { select: { cosmetics?: unknown } } } }
    ];
    expect(args.select.seller.select.cosmetics).toBeDefined();
  });

  it('hides an X-rated offering from an SFW viewer and shows it to one who browses X', async () => {
    const pg13 = row();
    const x = row({ maxNsfwLevel: NsfwLevel.X });
    table = [pg13, x];
    // Signed out: no level, so nothing mature.
    expect(await feedIds({ viewerId: undefined })).toEqual([pg13.id]);
    expect(await feedIds({ browsingLevel: sfwBrowsingLevelsFlag })).toEqual([pg13.id]);
    expect(await feedIds({ browsingLevel: allBrowsingLevelsFlag })).toEqual([x.id, pg13.id]);
    // A domain that serves nothing mature hides it whatever the viewer browses at.
    expect(
      await feedIds({ browsingLevel: allBrowsingLevelsFlag, servable: sfwBrowsingLevelsFlag })
    ).toEqual([pg13.id]);
  });

  it("hides an offering until its content checks, and its cover's, are done", async () => {
    const shown = row();
    const cover = (ingestion: ImageIngestionStatus) => ({
      coverImageId: 1,
      coverImage: { ingestion, needsReview: null, tosViolation: false, nsfwLevel: NsfwLevel.PG },
    });
    const withCover = row(cover(ImageIngestionStatus.Scanned));
    table = [
      shown,
      withCover,
      row({ ingestion: ServiceOfferingIngestionStatus.Pending }),
      row({ ingestion: ServiceOfferingIngestionStatus.Blocked }),
      row(cover(ImageIngestionStatus.Pending)),
    ];
    expect(await feedIds()).toEqual([withCover.id, shown.id]);
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

  it('hides offerings of banned, muted and deleted sellers, and of sellers with no username', async () => {
    const good = row();
    table = [
      good,
      row({ seller: { bannedAt: new Date() } }),
      row({ seller: { muted: true } }),
      row({ seller: { deletedAt: new Date() } }),
      row({ seller: { username: null } }),
    ];
    expect(await feedIds()).toEqual([good.id]);
  });

  it("hides a seller whose shop isn't published", async () => {
    const shown = row();
    table = [
      shown,
      row({ sellerId: 9, seller: { settings: { creatorShop: { enabled: false } } } }),
      row({ sellerId: 10, seller: { settings: {} } }),
    ];
    expect(await feedIds()).toEqual([shown.id]);
  });

  it('hides sellers the viewer hid, blocked, or was blocked by', async () => {
    const shown = row();
    table = [shown, row({ sellerId: 8 }), row({ sellerId: 11 }), row({ sellerId: 12 })];
    hidden.mockResolvedValue(users(8));
    blocked.mockResolvedValue(users(11));
    blockedBy.mockResolvedValue(users(12));
    expect(await feedIds()).toEqual([shown.id]);
    for (const cache of [hidden, blocked, blockedBy])
      expect(cache).toHaveBeenCalledWith({ userId: VISITOR });
  });

  it.each([
    ['newest', [5, 4, 3, 2, 1]],
    ['price_asc', [3, 1, 2, 4, 5]],
    ['price_desc', [5, 4, 2, 1, 3]],
  ] as const)('pages through every %s offering once, in order', async (sort, expected) => {
    // Ids 2 and 4 share a price, so the id tiebreak decides their order.
    table = [300, 500, 100, 500, 900].map((price) => row({ price }));
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await getServiceOfferingFeed({
        sort,
        limit: 2,
        cursor,
        servable: allBrowsingLevelsFlag,
      });
      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(expected);
  });

  describe('with a search query', () => {
    it('keeps only offerings whose title or description matches, ignoring case', async () => {
      const byTitle = row({ title: 'Anime LoRA training' });
      const byDescription = row({ description: 'I train a LoRA on your character.' });
      const other = row({ title: 'Logo design', description: 'Vector logos.' });
      table = [byTitle, byDescription, other];
      expect(await feedIds({ query: 'lora' })).toEqual([byDescription.id, byTitle.id]);
      expect(await feedIds({})).toEqual([other.id, byDescription.id, byTitle.id]);
    });

    it('never returns a mature match on civitai.com, and does on civitai.red', async () => {
      const pg = row({ title: 'Portrait commission' });
      const x = row({ title: 'Portrait commission, mature', maxNsfwLevel: NsfwLevel.X });
      table = [pg, x];
      const query = 'portrait';
      // civitai.com serves nothing mature, whatever the viewer browses at.
      expect(
        await feedIds({
          query,
          browsingLevel: allBrowsingLevelsFlag,
          servable: sfwBrowsingLevelsFlag,
        })
      ).toEqual([pg.id]);
      // civitai.red, browsing X: the same query finds it.
      expect(
        await feedIds({
          query,
          browsingLevel: allBrowsingLevelsFlag,
          servable: allBrowsingLevelsFlag,
        })
      ).toEqual([x.id, pg.id]);
    });

    it('matches `%` and `_` literally, not as wildcards', async () => {
      const discount = row({ title: '50% off portraits' });
      const other = row({ title: 'Logo design' });
      table = [discount, other];
      expect(await feedIds({ query: '%' })).toEqual([discount.id]);
      expect(await feedIds({ query: '_' })).toEqual([]);
    });

    it("on civitai.red, still hides a mature match above the viewer's browsing level", async () => {
      const r = row({ title: 'Portrait commission', maxNsfwLevel: NsfwLevel.R });
      const x = row({ title: 'Portrait commission, mature', maxNsfwLevel: NsfwLevel.X });
      table = [r, x];
      expect(
        await feedIds({
          query: 'portrait',
          browsingLevel: sfwBrowsingLevelsFlag | NsfwLevel.R,
          servable: allBrowsingLevelsFlag,
        })
      ).toEqual([r.id]);
    });

    it("never returns a muted seller's matching offering", async () => {
      const unmuted = row({ title: 'Portrait commission' });
      const muted = row({ title: 'Portrait commission', sellerId: 8, seller: { muted: true } });
      table = [unmuted, muted];
      expect(await feedIds({ query: 'portrait' })).toEqual([unmuted.id]);
    });

    it('keeps the listing rule for a match whose cover is still being checked', async () => {
      const pending = row({
        title: 'Portrait commission',
        coverImageId: 1,
        coverImage: {
          ingestion: ImageIngestionStatus.Pending,
          needsReview: null,
          tosViolation: false,
          nsfwLevel: NsfwLevel.PG,
        },
      });
      table = [pending];
      expect(await feedIds({ query: 'portrait' })).toEqual([]);
    });
  });
});

describe('the feed query input', () => {
  const parse = (query?: string) => getServiceOfferingFeedSchema.parse({ query }).query;

  it('treats a blank query as no filter, and searches on at most 100 characters', () => {
    expect(parse('   ')).toBeUndefined();
    expect(parse('  lora  ')).toBe('lora');
    expect(parse('a'.repeat(300))).toHaveLength(100);
  });
});

describe('services feed covers restricted by their base model', () => {
  const cover = (nsfwLevel: number, modelRestricted: boolean) => ({
    coverImageId: 1,
    coverImage: {
      ingestion: ImageIngestionStatus.Scanned,
      needsReview: null,
      tosViolation: false,
      nsfwLevel,
      modelRestricted,
    },
  });

  it('keeps the offering listed but withholds a mature restricted cover, even from its seller', async () => {
    const restricted = row({ maxNsfwLevel: NsfwLevel.R, ...cover(NsfwLevel.R, true) });
    const sfw = row(cover(NsfwLevel.PG, true));
    const clean = row({ maxNsfwLevel: NsfwLevel.R, ...cover(NsfwLevel.R, false) });
    table = [restricted, sfw, clean];
    for (const viewerId of [VISITOR, SELLER]) {
      const { items } = await getServiceOfferingFeed({
        sort: 'newest',
        limit: 50,
        servable: allBrowsingLevelsFlag,
        browsingLevel: allBrowsingLevelsFlag,
        viewerId,
      });
      const covers = Object.fromEntries(items.map((i) => [i.id, i.coverImage]));
      expect(covers[restricted.id]).toBeNull();
      expect(covers[sfw.id]).toMatchObject({ nsfwLevel: NsfwLevel.PG });
      expect(covers[clean.id]).toMatchObject({ nsfwLevel: NsfwLevel.R });
    }
  });
});
