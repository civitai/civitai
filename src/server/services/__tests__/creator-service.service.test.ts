import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getShopServiceOfferings,
  hasOpenServiceDeal,
  removeServiceOffering,
  setServiceOfferingStatus,
  upsertServiceOffering,
} from '~/server/services/creator-service.service';
import {
  SERVICE_MAX_ACTIVE_OFFERINGS,
  SERVICES_MIN_CREATOR_SCORE,
} from '~/shared/constants/creator-service.constants';
import { upsertServiceOfferingSchema } from '~/server/schema/creator-service.schema';
import { MUTE_POINTS } from '~/shared/constants/strike.constants';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  isMatureServiceRating,
  visibleMatureServiceRatings,
} from '~/shared/constants/creator-service.constants';

const SELLER = 7;
const fields = {
  title: 'Custom badge',
  description: 'One animated badge.',
  price: 4000,
  deliveryDays: 5,
  revisionsIncluded: 2,
  maxOpenDeals: 3,
  previewKind: 'Image' as const,
};

const seller = ({ score = SERVICES_MIN_CREATOR_SCORE, muted = false, strikePoints = 0 } = {}) => {
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    meta: { scores: { total: score } },
    bannedAt: null,
    muted,
    deletedAt: null,
  } as never);
  dbMock.dbRead.userStrike.aggregate.mockResolvedValue({ _sum: { points: strikePoints } } as never);
};

const rejects = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.serviceOffering.count.mockResolvedValue(0 as never);
  dbMock.dbWrite.serviceOffering.create.mockResolvedValue({ id: 1 } as never);
  dbMock.dbWrite.serviceOffering.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe('sell gate', () => {
  it('refuses to publish an existing draft below Beacon and writes nothing', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE - 1 });
    dbMock.dbWrite.serviceOffering.findFirst.mockResolvedValue({
      status: ServiceOfferingStatus.Draft,
    } as never);
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, id: 5, publish: true } })
      )
    ).toMatch(/unlocks at a Creator Score/);
    expect(dbMock.dbWrite.serviceOffering.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a seller whose active strikes reach the mute threshold', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE * 2, strikePoints: MUTE_POINTS });
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: true } })
      )
    ).toMatch(/active strikes/);
    expect(dbMock.dbWrite.serviceOffering.create).not.toHaveBeenCalled();
  });

  it('refuses to create below Beacon and writes nothing', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE - 1 });
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: false } })
      )
    ).toMatch(/unlocks at a Creator Score/);
    expect(dbMock.dbWrite.serviceOffering.create).not.toHaveBeenCalled();
  });

  it('refuses a muted seller at any score', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE * 2, muted: true });
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: true } })
      )
    ).toMatch(/Muted/);
    expect(dbMock.dbWrite.serviceOffering.create).not.toHaveBeenCalled();
  });

  it('refuses to activate below Beacon, but still lets the seller pause', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE - 1 });
    expect(
      await rejects(
        setServiceOfferingStatus({ sellerId: SELLER, input: { id: 3, status: 'Active' } })
      )
    ).toMatch(/unlocks at a Creator Score/);
    expect(dbMock.dbWrite.serviceOffering.updateMany).not.toHaveBeenCalled();

    await setServiceOfferingStatus({ sellerId: SELLER, input: { id: 3, status: 'Paused' } });
    expect(dbMock.dbWrite.serviceOffering.updateMany).toHaveBeenCalledWith({
      where: { id: 3, sellerId: SELLER, status: { in: [ServiceOfferingStatus.Active] } },
      data: { status: ServiceOfferingStatus.Paused },
    });
  });
});

describe('writes', () => {
  it('creates a draft unless published, owned by the caller', async () => {
    seller();
    await upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: false } });
    await upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: true } });
    const statuses = dbMock.dbWrite.serviceOffering.create.mock.calls.map(
      ([args]) => (args as { data: { status: string; sellerId: number } }).data
    );
    expect(statuses).toEqual([
      expect.objectContaining({ status: ServiceOfferingStatus.Draft, sellerId: SELLER }),
      expect.objectContaining({ status: ServiceOfferingStatus.Active, sellerId: SELLER }),
    ]);
  });

  it('refuses to publish past the active cap', async () => {
    seller();
    dbMock.dbWrite.serviceOffering.count.mockResolvedValue(SERVICE_MAX_ACTIVE_OFFERINGS as never);
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: true } })
      )
    ).toMatch(/at most/);
    expect(dbMock.dbWrite.serviceOffering.create).not.toHaveBeenCalled();
  });

  it("only edits the caller's own, non-removed offering", async () => {
    seller();
    dbMock.dbWrite.serviceOffering.findFirst.mockResolvedValue(null as never);
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, id: 9, publish: false } })
      )
    ).toMatch(/not found/i);
    expect(dbMock.dbWrite.serviceOffering.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9, sellerId: SELLER, status: { not: ServiceOfferingStatus.Removed } },
      })
    );
    expect(dbMock.dbWrite.serviceOffering.updateMany).not.toHaveBeenCalled();
  });

  it('removes by status, scoped to the caller', async () => {
    await removeServiceOffering({ sellerId: SELLER, id: 4 });
    expect(dbMock.dbWrite.serviceOffering.updateMany).toHaveBeenCalledWith({
      where: { id: 4, sellerId: SELLER, status: { not: ServiceOfferingStatus.Removed } },
      data: { status: ServiceOfferingStatus.Removed },
    });
  });
});

describe('storefront read', () => {
  const VISITOR = 99;
  const ALL = allBrowsingLevelsFlag;
  const shopEnabled = (enabled: boolean) =>
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      settings: { creatorShop: { enabled } },
    } as never);

  it('shows only Active offerings of a seller in good standing', async () => {
    shopEnabled(true);
    dbMock.dbRead.serviceOffering.findMany.mockResolvedValue([] as never);
    await getShopServiceOfferings({ userId: SELLER, viewerId: VISITOR, servable: ALL });
    expect(dbMock.dbRead.serviceOffering.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sellerId: SELLER,
          status: ServiceOfferingStatus.Active,
          seller: { bannedAt: null, deletedAt: null, muted: false },
          maxNsfwLevel: { lte: NsfwLevel.PG13 },
        },
      })
    );
  });

  it('shows open slots as the cap minus open deals, and none for an uncapped offering', async () => {
    shopEnabled(true);
    dbMock.dbRead.serviceOffering.findMany.mockResolvedValue([
      { id: 1, maxOpenDeals: 3 },
      { id: 2, maxOpenDeals: null },
      { id: 3, maxOpenDeals: 1 },
    ] as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      { offeringId: 1, open: 2 },
      { offeringId: 3, open: 4 },
    ] as never);
    const offerings = await getShopServiceOfferings({
      userId: SELLER,
      viewerId: VISITOR,
      servable: ALL,
    });
    expect(offerings.map((o) => [o.id, o.slotsOpen])).toEqual([
      [1, 1],
      [2, null],
      [3, 0],
    ]);
  });

  it("hides a private shop's offerings from visitors, not from its owner", async () => {
    shopEnabled(false);
    expect(
      await rejects(getShopServiceOfferings({ userId: SELLER, viewerId: VISITOR, servable: ALL }))
    ).toBe('Shop not found');
    expect(dbMock.dbRead.serviceOffering.findMany).not.toHaveBeenCalled();

    await getShopServiceOfferings({ userId: SELLER, viewerId: SELLER, servable: ALL });
    expect(dbMock.dbRead.serviceOffering.findMany).toHaveBeenCalledTimes(1);
  });
});

// Decision (Justin, 2026-10-14): no Blue Buzz for services in v1. `acceptsBlue` keeps its column
// default of false; nothing a client sends can set it. Remove this only when Blue ships with a fee.
it('drops a client-sent acceptsBlue before it reaches the write', async () => {
  seller();
  const input = upsertServiceOfferingSchema.parse({ ...fields, acceptsBlue: true, publish: true });
  expect(input).not.toHaveProperty('acceptsBlue');
  await upsertServiceOffering({ sellerId: SELLER, input });
  const [args] = dbMock.dbWrite.serviceOffering.create.mock.calls[0] as [{ data: object }];
  expect(args.data).not.toHaveProperty('acceptsBlue');
});

// A user whose deals are all closed has nothing to get back to, so the dark list 404s for them.
it('finds only OPEN deals on either side when deciding whether the dark list serves a user', async () => {
  dbMock.dbRead.serviceDeal.findFirst.mockResolvedValue(null as never);
  expect(await hasOpenServiceDeal(SELLER)).toBe(false);
  const [args] = dbMock.dbRead.serviceDeal.findFirst.mock.calls[0] as [
    { where: { OR: unknown; status: { in: string[] } } }
  ];
  expect(args.where.OR).toEqual([{ buyerId: SELLER }, { sellerId: SELLER }]);
  expect([...args.where.status.in].sort()).toEqual(
    ['Accepted', 'CancellationRequested', 'Delivered', 'Disputed', 'InRevision', 'Requested'].sort()
  );
  dbMock.dbRead.serviceDeal.findFirst.mockResolvedValue({ id: 1 } as never);
  expect(await hasOpenServiceDeal(SELLER)).toBe(true);
});

// Decision (Creator Services, briony 2026-10-15): SFW-always. An offering rated PG or PG-13 shows
// to everyone, everywhere, as before ratings existed; only a mature one (R and up) is held to the
// viewer's browsing level and the domain. Signed-out viewers browse at PG, so filtering every
// offering by level would hide every default (PG-13) offering from them.
describe('storefront ratings', () => {
  const VISITOR = 99;
  const shown = (browsingLevel: number | undefined, servable: number) =>
    visibleMatureServiceRatings({ browsingLevel, servable });
  const where = async (browsingLevel: number | undefined, servable: number) => {
    dbMock.dbRead.serviceOffering.findMany.mockResolvedValue([] as never);
    await getShopServiceOfferings({ userId: SELLER, viewerId: VISITOR, browsingLevel, servable });
    return dbMock.dbRead.serviceOffering.findMany.mock.calls.at(-1)?.[0]?.where;
  };
  // A row passes the read's rating filter as Prisma would apply it.
  const passes = (filter: Record<string, unknown>, rating: number) => {
    const test = (clause: { maxNsfwLevel: { lte?: number; in?: number[] } }) =>
      clause.maxNsfwLevel.lte !== undefined
        ? rating <= clause.maxNsfwLevel.lte
        : !!clause.maxNsfwLevel.in?.includes(rating);
    return 'OR' in filter
      ? (filter.OR as never[]).some(test)
      : test(filter as { maxNsfwLevel: { lte?: number } });
  };

  beforeEach(() => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      settings: { creatorShop: { enabled: true } },
    } as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  });

  it('shows a PG-13 offering and hides an R one from a signed-out (PG-only) viewer', async () => {
    const filter = (await where(publicBrowsingLevelsFlag, allBrowsingLevelsFlag)) as never;
    expect(passes(filter, NsfwLevel.PG13)).toBe(true);
    expect(passes(filter, NsfwLevel.PG)).toBe(true);
    expect(passes(filter, NsfwLevel.R)).toBe(false);
  });

  it('shows mature offerings only at levels the viewer browses and the domain serves', async () => {
    const red = (await where(NsfwLevel.PG | NsfwLevel.R, allBrowsingLevelsFlag)) as never;
    expect(passes(red, NsfwLevel.R)).toBe(true);
    expect(passes(red, NsfwLevel.XXX)).toBe(false);
    expect(passes(red, NsfwLevel.PG13)).toBe(true);
    // Green serves nothing mature, whatever the viewer browses at.
    const green = (await where(allBrowsingLevelsFlag, sfwBrowsingLevelsFlag)) as never;
    expect(passes(green, NsfwLevel.R)).toBe(false);
    expect(passes(green, NsfwLevel.PG13)).toBe(true);
  });

  it('treats no level as nothing mature, never as everything', () => {
    expect(shown(undefined, allBrowsingLevelsFlag)).toEqual([]);
    expect(shown(allBrowsingLevelsFlag, allBrowsingLevelsFlag)).toEqual([
      NsfwLevel.R,
      NsfwLevel.X,
      NsfwLevel.XXX,
    ]);
    expect(isMatureServiceRating(NsfwLevel.PG13)).toBe(false);
    expect(isMatureServiceRating(NsfwLevel.R)).toBe(true);
  });

  it('accepts one rating bit and refuses Blocked or a mask with a 400', () => {
    const base = { ...fields };
    expect(upsertServiceOfferingSchema.parse(base).maxNsfwLevel).toBe(NsfwLevel.PG13);
    expect(
      upsertServiceOfferingSchema.safeParse({ ...base, maxNsfwLevel: NsfwLevel.X }).success
    ).toBe(true);
    for (const bad of [NsfwLevel.Blocked, NsfwLevel.PG | NsfwLevel.R, 0, 3])
      expect(upsertServiceOfferingSchema.safeParse({ ...base, maxNsfwLevel: bad }).success).toBe(
        false
      );
  });
});
