import type * as EventShopItem from '~/server/events/event-shop-item';
import { computeBoxOdds, drawWithRolls } from '@civitai/shared/box-odds';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// What the event page shows of an event's mystery boxes: which boxes, what each holds for the
// viewer's team, what is still left for them, and the boxes they hold. The odds the page shows are
// `computeBoxOdds` over the left contents, the rule and the pool the open draws from.

const { mocks } = vi.hoisted(() => ({ mocks: { boxViewer: vi.fn(), catalogAccess: vi.fn() } }));

vi.mock('~/server/events/event-shop-item', async (importOriginal) => ({
  ...(await importOriginal<typeof EventShopItem>()),
  getEventBoxViewer: mocks.boxViewer,
  getEventBoxCatalogAccess: mocks.catalogAccess,
}));

import {
  clearBoxCatalogDisplayCache,
  getBoxPoolForUser,
  getMysteryBoxCatalogForEvent,
  getMysteryBoxesForEvent,
} from '../mystery-box.service';
import {
  baseOddsView,
  boxOddsFor,
  revealChance,
  sharedBaseTierOdds,
  tierSummaries,
} from '~/components/MysteryBox/mystery-box.utils';
import { dbMock } from '~/__tests__/mocks/db.mock';

const VIEWER = 1;
const EVENT = 'birthday2026';
const BOX = 9;
const SECOND_BOX = 12;
const OTHER_EVENT_BOX = 11;
const COMMON = 7;
const RARE = 6;
const SECOND_TIER = 20;

type Content = {
  id: number;
  boxDefinitionId: number;
  tierId: number;
  rewardDefinitionId: number;
  enabled: boolean;
  reward: {
    type: string;
    cosmeticId: number | null;
    cosmetic: { name: string; data: unknown; type: string } | null;
  };
};
const hat = (n: number, tierId: number, team?: string, boxDefinitionId = BOX): Content => ({
  id: n,
  boxDefinitionId,
  tierId,
  rewardDefinitionId: 100 + n,
  enabled: true,
  reward: {
    type: 'cosmetic',
    cosmeticId: 1000 + n,
    cosmetic: {
      name: `Hat ${n}`,
      data: { event: EVENT, url: `hat-${n}.png`, ...(team ? { team } : {}) },
      type: 'ContentDecoration',
    },
  },
});

type Listing = {
  id: number;
  itemDefinitionId: number;
  status: string;
  title: string;
  unitAmount: number;
  availableQuantity: number | null;
  availableFrom: Date | null;
  availableTo: Date | null;
  /** Purchase rows for it; read through the sold-count query, never a relation count. */
  sold: number;
};

let world: {
  boxes: {
    id: number;
    type: string;
    status: string;
    params: unknown;
    version: number;
    name: string;
    description: string | null;
  }[];
  listings: Listing[];
  tiers: {
    id: number;
    boxDefinitionId: number;
    key: string;
    name: string;
    color: string | null;
    weight: number;
    sortOrder: number;
  }[];
  contents: Content[];
  owned: { userId: number; cosmeticId: number }[];
  drawn: {
    userId: number;
    boxDefinitionId: number;
    rewardDefinitionId: number;
    rewardStatus?: string;
  }[];
  items: { id: bigint; itemDefinitionId: number; holderType: string; holderId: number }[];
  blocked: unknown;
};

const inList = (value: unknown, filter: unknown) =>
  filter && typeof filter === 'object' && 'in' in filter
    ? (filter as { in: unknown[] }).in.includes(value)
    : value === filter;

type Select = { [key: string]: boolean | { select: Select } };
/** What Prisma returns for a select: only the fields named, nested selects applied. */
function project(row: Record<string, unknown>, select?: Select): Record<string, unknown> {
  if (!select) return row;
  return Object.fromEntries(
    Object.entries(select).map(([key, pick]) => {
      const value = row[key];
      if (pick === true) return [key, value];
      return [
        key,
        value && typeof value === 'object' && typeof pick === 'object'
          ? project(value as Record<string, unknown>, pick.select)
          : value,
      ];
    })
  );
}
const byId = (order?: { id: 'asc' | 'desc' }) => (a: { id: unknown }, b: { id: unknown }) =>
  order ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * (order.id === 'asc' ? 1 : -1) : 0;

type Args = { where: Record<string, never>; select?: Select; orderBy?: { id: 'asc' | 'desc' } };

function installWorld() {
  const db = dbMock.dbRead;
  db.keyValue.findUnique.mockReset();
  db.keyValue.findUnique.mockImplementation(async () =>
    world.blocked === undefined ? null : { value: world.blocked }
  );
  db.itemDefinition.findMany.mockReset();
  db.itemDefinition.findMany.mockImplementation(async ({ where, select, orderBy }: Args) => {
    const params = where.params as { path: string[]; equals: string };
    // The event lives at params.event; any other path is a different query.
    if (params.path.join('.') !== 'event') return [];
    return world.boxes
      .filter(
        (b) =>
          b.type === where.type &&
          inList(b.status, where.status) &&
          (b.params as { event?: string }).event === params.equals
      )
      .sort(byId(orderBy))
      .map((b) => project(b, select));
  });
  db.cosmeticShopItem.findMany.mockReset();
  db.cosmeticShopItem.findMany.mockImplementation(async ({ where, select, orderBy }: Args) =>
    world.listings
      .filter((l) => inList(l.itemDefinitionId, where.itemDefinitionId))
      .filter((l) => l.status === where.status)
      .sort(byId(orderBy))
      .map((l) => project(l, select))
  );
  db.$queryRaw.mockReset();
  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join('?').includes('"UserCosmeticShopPurchases"')) throw new Error('unexpected');
    const ids = values[0] as number[];
    return world.listings
      .filter((l) => ids.includes(l.id) && l.sold > 0)
      .map((l) => ({ shopItemId: l.id, sold: l.sold }));
  });
  db.item.findMany.mockReset();
  db.item.findMany.mockImplementation(async ({ where, select, orderBy }: Args) =>
    world.items
      .filter(
        (i) =>
          i.holderType === where.holderType &&
          i.holderId === where.holderId &&
          inList(i.itemDefinitionId, where.itemDefinitionId)
      )
      .sort(byId(orderBy))
      .map((i) => project(i, select))
  );
  db.boxTier.findMany.mockReset();
  db.boxTier.findMany.mockImplementation(async ({ where, select }: Args) =>
    world.tiers
      .filter((t) => inList(t.boxDefinitionId, where.boxDefinitionId))
      .map((t) => project(t, select))
  );
  db.boxContent.findMany.mockReset();
  db.boxContent.findMany.mockImplementation(async ({ where, select }: Args) =>
    world.contents
      .filter((c) => c.boxDefinitionId === where.boxDefinitionId && c.enabled === where.enabled)
      .map((c) => project(c, select))
  );
  db.userCosmetic.findMany.mockReset();
  db.userCosmetic.findMany.mockImplementation(
    async ({ where }: { where: { userId: number; cosmeticId: { in: number[] } } }) =>
      world.owned.filter(
        (o) => o.userId === where.userId && where.cosmeticId.in.includes(o.cosmeticId)
      )
  );
  db.boxOpening.findMany.mockReset();
  db.boxOpening.findMany.mockImplementation(
    async ({
      where,
    }: {
      where: { userId: number; boxDefinitionId: number; rewardStatus?: string };
    }) =>
      world.drawn.filter(
        (d) =>
          d.userId === where.userId &&
          d.boxDefinitionId === where.boxDefinitionId &&
          (where.rewardStatus === undefined || (d.rewardStatus ?? 'granted') === where.rewardStatus)
      )
  );
}

const read = (
  overrides: Partial<Parameters<typeof getMysteryBoxesForEvent>[0]> = {}
): ReturnType<typeof getMysteryBoxesForEvent> =>
  getMysteryBoxesForEvent({
    userId: VIEWER,
    isModerator: false,
    event: EVENT,
    mysteryBoxEnabled: true,
    countryCode: 'US',
    ...overrides,
  });

const listing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 42,
  itemDefinitionId: BOX,
  status: 'Published',
  title: 'Listing 42',
  unitAmount: 500,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  sold: 0,
  ...overrides,
});
const tier = (id: number, boxDefinitionId: number, weight: number, sortOrder: number) => ({
  id,
  boxDefinitionId,
  key: `t${id}`,
  name: `Tier ${id}`,
  color: sortOrder ? '#3b82f6' : null,
  weight,
  sortOrder,
});
const box = (id: number, params: unknown, version = 3) => ({
  id,
  type: 'box',
  status: 'published',
  params,
  version,
  name: `Box ${id}`,
  description: `About box ${id}`,
});
const held = (id: bigint, itemDefinitionId = BOX, holderId = VIEWER, holderType = 'user') => ({
  id,
  itemDefinitionId,
  holderType,
  holderId,
});

// The region list is cached for a minute per pod; each case starts past the last one's cache.
const base = new Date('2026-11-08T12:00:00Z').getTime();
let step = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(base + step++ * 5 * 60_000);
  clearBoxCatalogDisplayCache();
  world = {
    boxes: [box(BOX, { event: EVENT }), box(OTHER_EVENT_BOX, { event: 'other' }, 1)],
    listings: [listing(), listing({ id: 43, itemDefinitionId: OTHER_EVENT_BOX })],
    tiers: [tier(COMMON, BOX, 3, 0), tier(RARE, BOX, 1, 1)],
    contents: [
      hat(1, COMMON, 'Pink'),
      hat(2, COMMON, 'Pink'),
      hat(3, COMMON, 'Blue'),
      hat(4, RARE, 'Pink'),
      hat(5, RARE),
    ],
    owned: [],
    drawn: [],
    items: [],
    blocked: undefined,
  };
  installWorld();
  mocks.boxViewer.mockReset();
  mocks.boxViewer.mockResolvedValue({ team: 'Pink', playable: true });
  mocks.catalogAccess.mockReset();
  mocks.catalogAccess.mockResolvedValue({
    title: 'Birthday',
    teams: ['Pink', 'Blue'],
    playable: true,
  });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('getMysteryBoxesForEvent', () => {
  it("shows the event's box on sale, with what it holds for the viewer's team", async () => {
    const [view, ...rest] = await read();

    expect(rest).toEqual([]);
    expect(mocks.boxViewer).toHaveBeenCalledWith(EVENT, { id: VIEWER, isModerator: false });
    expect(view).toMatchObject({
      boxDefinitionId: BOX,
      name: `Box ${BOX}`,
      description: `About box ${BOX}`,
      version: 3,
      team: 'Pink',
      listing: { shopItemId: 42, title: 'Listing 42', unitAmount: 500, availableTo: null },
      heldBoxItemIds: [],
    });
    expect(view.tiers).toEqual([
      {
        id: COMMON,
        key: `t${COMMON}`,
        name: `Tier ${COMMON}`,
        color: null,
        weight: 3,
        sortOrder: 0,
      },
      {
        id: RARE,
        key: `t${RARE}`,
        name: `Tier ${RARE}`,
        color: '#3b82f6',
        weight: 1,
        sortOrder: 1,
      },
    ]);
    // Blue's hat is not in it; a hat with no team is.
    expect(view.contents.map((c) => c.cosmeticId)).toEqual([1001, 1002, 1004, 1005]);
    expect(view.contents[0]).toEqual({
      contentId: 1,
      tierId: COMMON,
      cosmeticId: 1001,
      name: 'Hat 1',
      url: 'hat-1.png',
      fit: null,
      left: true,
    });
  });

  it("asks the event's gate as a moderator when the viewer is one", async () => {
    await read({ isModerator: true });
    expect(mocks.boxViewer).toHaveBeenCalledWith(EVENT, { id: VIEWER, isModerator: true });
  });

  it("passes the listing's end through, for the shelf's countdown", async () => {
    const ends = new Date(base + 30 * 86_400_000);
    world.listings[0] = listing({ availableTo: ends });
    expect((await read())[0].listing?.availableTo).toEqual(ends);
  });

  it("sends only the fit a preview sizes by, not the hat's wearing outline", async () => {
    const fit = { bounds: [1, 2, 30, 40], canvas: [128, 160], brim: [1, 2, 3], outline: [[0, 0]] };
    (world.contents[0].reward.cosmetic!.data as Record<string, unknown>).fit = fit;

    const [view] = await read();

    expect(view.contents[0].fit).toEqual({ bounds: [1, 2, 30, 40], canvas: [128, 160] });
  });

  it('marks owned and already-drawn rewards as not left, and the odds follow', async () => {
    world.owned.push({ userId: VIEWER, cosmeticId: 1001 }, { userId: 2, cosmeticId: 1002 });
    world.drawn.push({ userId: VIEWER, boxDefinitionId: BOX, rewardDefinitionId: 104 });

    const [view] = await read();

    expect(view.contents.map((c) => [c.cosmeticId, c.left])).toEqual([
      [1001, false],
      [1002, true],
      [1004, false],
      [1005, true],
    ]);
  });

  it('keeps a reward a moderator refunded as drawn: a refund cannot be used to redraw it', async () => {
    world.drawn.push({
      userId: VIEWER,
      boxDefinitionId: BOX,
      rewardDefinitionId: 104,
      rewardStatus: 'refunded',
    });

    const [view] = await read();

    expect(view.contents.find((c) => c.cosmeticId === 1004)?.left).toBe(false);
  });

  it('reads the contents once per box version; an edit that bumps the version shows at once', async () => {
    await read();
    world.contents.push(hat(8, COMMON, 'Pink'));
    expect((await read())[0].contents.map((c) => c.contentId)).toEqual([1, 2, 4, 5]);
    expect(dbMock.dbRead.boxContent.findMany).toHaveBeenCalledTimes(1);

    world.boxes[0].version = 4;
    const [view] = await read();
    expect(view.version).toBe(4);
    expect(view.contents.map((c) => c.contentId)).toEqual([1, 2, 4, 5, 8]);

    // The replaced version is dropped, not kept: a read of it again goes to the database.
    world.boxes[0].version = 3;
    await read();
    expect(dbMock.dbRead.boxContent.findMany).toHaveBeenCalledTimes(3);
  });

  it('shows a change made without a version bump after a minute', async () => {
    await read();
    (world.contents[0].reward.cosmetic!.data as Record<string, unknown>).team = 'Blue';

    vi.setSystemTime(Date.now() + 59_000);
    expect((await read())[0].contents.map((c) => c.contentId)).toEqual([1, 2, 4, 5]);
    vi.setSystemTime(Date.now() + 2_000);
    expect((await read())[0].contents.map((c) => c.contentId)).toEqual([2, 4, 5]);
  });

  it('marks what the viewer collected since the contents were cached as not left', async () => {
    await read();
    world.owned.push({ userId: VIEWER, cosmeticId: 1001 });
    world.drawn.push({ userId: VIEWER, boxDefinitionId: BOX, rewardDefinitionId: 102 });

    const [view] = await read();

    expect(dbMock.dbRead.boxContent.findMany).toHaveBeenCalledTimes(1);
    expect(view.contents.map((c) => [c.cosmeticId, c.left])).toEqual([
      [1001, false],
      [1002, false],
      [1004, true],
      [1005, true],
    ]);
  });

  it("the open's pool reads the contents live, not the cached ones the page shows", async () => {
    await read();
    world.contents = world.contents.filter((c) => c.id !== 2);

    const pool = await getBoxPoolForUser(dbMock.dbRead as never, {
      boxDefinitionId: BOX,
      userId: VIEWER,
      team: 'Pink',
    });

    expect(pool.map((entry) => entry.contentId)).toEqual([1, 4, 5]);
  });

  it('shows the odds the open draws under: the shared rule over the same pool', async () => {
    world.owned.push({ userId: VIEWER, cosmeticId: 1002 });
    const [view] = await read();

    const pool = await getBoxPoolForUser(dbMock.dbRead as never, {
      boxDefinitionId: BOX,
      userId: VIEWER,
      team: 'Pink',
    });
    const drawnUnder = computeBoxOdds(
      world.tiers.map(({ id, weight, sortOrder }) => ({ id, weight, sortOrder })),
      pool
    );
    expect(boxOddsFor(view)).toEqual(drawnUnder);
    // Common 3 : Rare 1, one hat left in Common, two in Rare.
    expect(drawnUnder.tiers.map((t) => [t.tierId, t.probability, t.contentIds])).toEqual([
      [COMMON, 0.75, [1]],
      [RARE, 0.25, [4, 5]],
    ]);

    // Every reward's chance as the page shows it is the chance a draw records for it.
    for (const t of drawnUnder.tiers) {
      const tierRoll = drawnUnder.tiers
        .slice(0, drawnUnder.tiers.indexOf(t))
        .reduce((sum, earlier) => sum + earlier.weight, 0);
      const draw = drawWithRolls(drawnUnder, { tierRoll, itemRoll: 0 });
      const shown = tierSummaries(view).find((s) => s.tier.id === draw.tierId)!;
      expect(revealChance(draw)).toBeCloseTo(shown.itemProbability, 12);
    }
  });

  it("lists the viewer's unopened boxes oldest first, not anyone else's", async () => {
    world.items.push(
      held(503n),
      held(502n, BOX, 2),
      held(501n),
      // Same holder id, not a user: a faction or other holder type.
      held(504n, BOX, VIEWER, 'faction')
    );

    const [view] = await read();

    expect(view.heldBoxItemIds).toEqual(['501', '503']);
  });

  it("keeps each box's listing, tiers and held boxes to itself", async () => {
    world.boxes.push(box(SECOND_BOX, { event: EVENT }, 7));
    world.tiers.push(tier(SECOND_TIER, SECOND_BOX, 1, 0));
    world.contents.push(hat(30, SECOND_TIER, undefined, SECOND_BOX));
    // An ended listing listed before a live one.
    world.listings.push(
      listing({ id: 44, itemDefinitionId: SECOND_BOX, availableTo: new Date(base - 86_400_000) }),
      listing({ id: 45, itemDefinitionId: SECOND_BOX })
    );
    world.items.push(held(601n, SECOND_BOX));

    const views = await read();

    expect(
      views.map((v) => ({
        box: v.boxDefinitionId,
        listing: v.listing?.shopItemId,
        tiers: v.tiers.map((t) => t.id),
        contents: v.contents.map((c) => c.contentId),
        held: v.heldBoxItemIds,
      }))
    ).toEqual([
      { box: BOX, listing: 42, tiers: [COMMON, RARE], contents: [1, 2, 4, 5], held: [] },
      { box: SECOND_BOX, listing: 45, tiers: [SECOND_TIER], contents: [30], held: ['601'] },
    ]);
  });

  it.each([
    ['not started', { availableFrom: new Date(base + 365 * 86_400_000) }],
    ['ended', { availableTo: new Date(base - 86_400_000) }],
    ['sold out', { availableQuantity: 10, sold: 10 }],
    ['unpublished', { status: 'Unpublished' }],
  ])('leaves out a box whose listing is %s, unless the viewer holds one', async (_, change) => {
    world.listings[0] = listing(change);
    expect(await read()).toEqual([]);

    world.items.push(held(501n));
    const [view] = await read();
    expect(view.listing).toBeNull();
    expect(view.heldBoxItemIds).toEqual(['501']);
  });

  it('sells a capped box until its purchases reach the cap, counting only capped listings', async () => {
    world.listings[0] = listing({ availableQuantity: 10, sold: 9 });
    expect((await read())[0].listing?.shopItemId).toBe(42);

    // An uncapped listing never reads the purchase rows.
    world.listings[0] = listing({ sold: 500 });
    dbMock.dbRead.$queryRaw.mockClear();
    expect((await read())[0].listing?.shopItemId).toBe(42);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('still shows an archived box the viewer holds, never for sale', async () => {
    world.boxes[0].status = 'archived';
    expect(await read()).toEqual([]);

    world.items.push(held(501n));
    const [view] = await read();
    expect(view.listing).toBeNull();
  });

  it('leaves out a draft box, even one held', async () => {
    world.boxes[0].status = 'draft';
    world.items.push(held(501n));
    expect(await read()).toEqual([]);
  });

  it('once the event is no longer playable, shows only the boxes the viewer holds, not for sale', async () => {
    mocks.boxViewer.mockResolvedValue({ team: 'Pink', playable: false });
    expect(await read()).toEqual([]);

    world.items.push(held(501n));
    const [view] = await read();
    expect(view.listing).toBeNull();
    expect(view.heldBoxItemIds).toEqual(['501']);
  });

  it('shows nothing when the event is closed to the viewer or their team cannot be read', async () => {
    world.items.push(held(501n));
    mocks.boxViewer.mockResolvedValue(null);
    expect(await read()).toEqual([]);
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });

  it("shows an event without teams every hat but the teams' own", async () => {
    mocks.boxViewer.mockResolvedValue({ team: undefined, playable: true });
    const [view] = await read();
    expect(view.team).toBeUndefined();
    expect(view.contents.map((c) => c.cosmeticId)).toEqual([1005]);
  });

  it.each([[false], [undefined]])('shows nothing with boxes off (%s)', async (enabled) => {
    expect(await read({ mysteryBoxEnabled: enabled })).toEqual([]);
    expect(mocks.boxViewer).not.toHaveBeenCalled();
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });

  it('shows nothing in a blocked country, nor where the country is unknown', async () => {
    world.blocked = ['BE', 'NL'];
    expect(await read({ countryCode: 'be' })).toEqual([]);
    expect(await read({ countryCode: null })).toEqual([]);
    expect(await read({ countryCode: 'US' })).toHaveLength(1);
  });

  it('hides boxes everywhere when the region list is malformed', async () => {
    world.blocked = 'BE';
    expect(await read()).toEqual([]);
  });

  it('reads the region list once a minute, not per view', async () => {
    world.blocked = ['BE'];
    await read();
    vi.setSystemTime(Date.now() + 59_000);
    await read({ countryCode: 'BE' });
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(1);

    // A change shows after the minute.
    world.blocked = ['US'];
    vi.setSystemTime(Date.now() + 2_000);
    expect(await read({ countryCode: 'US' })).toEqual([]);
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(2);
  });

  it('draws the box art for the viewer team only', async () => {
    world.boxes[0].params = {
      event: EVENT,
      art: {
        Pink: { closed: 'pink-closed.png', open: 'pink-open.png' },
        Blue: { closed: 'b.png' },
      },
    };
    expect((await read())[0].art).toEqual({ closed: 'pink-closed.png', open: 'pink-open.png' });

    mocks.boxViewer.mockResolvedValue({ team: 'Green', playable: true });
    expect((await read())[0].art).toBeNull();
  });
});

describe('getMysteryBoxCatalogForEvent', () => {
  const catalog = (
    overrides: Partial<Parameters<typeof getMysteryBoxCatalogForEvent>[0]> = {}
  ): ReturnType<typeof getMysteryBoxCatalogForEvent> =>
    getMysteryBoxCatalogForEvent({
      event: EVENT,
      viewer: undefined,
      mysteryBoxEnabled: true,
      countryCode: 'US',
      ...overrides,
    });

  it("shows a box on sale with every team's contents, reading no one's team", async () => {
    const [view, ...rest] = await catalog();

    expect(rest).toEqual([]);
    expect(view).toMatchObject({
      boxDefinitionId: BOX,
      name: `Box ${BOX}`,
      description: `About box ${BOX}`,
      unitAmount: 500,
    });
    expect(view.tiers.map((t) => t.id)).toEqual([COMMON, RARE]);
    expect(view.contents).toEqual([
      { contentId: 1, tierId: COMMON, team: 'Pink' },
      { contentId: 2, tierId: COMMON, team: 'Pink' },
      { contentId: 3, tierId: COMMON, team: 'Blue' },
      { contentId: 4, tierId: RARE, team: 'Pink' },
      { contentId: 5, tierId: RARE, team: null },
    ]);
    expect(view.teams).toEqual(['Pink', 'Blue']);
    expect(mocks.boxViewer).not.toHaveBeenCalled();
    expect(mocks.catalogAccess).toHaveBeenCalledWith(EVENT, undefined);
  });

  it('asks the event about a signed-in viewer', async () => {
    await catalog({ viewer: { id: VIEWER, isModerator: false } });
    expect(mocks.catalogAccess).toHaveBeenCalledWith(EVENT, { id: VIEWER, isModerator: false });
  });

  // Same source: each team's base view holds exactly the pool a member who owns nothing draws from,
  // and the card shows one bar only when every team's odds are the same.
  const drawnBy = async (team: string | undefined) => {
    const pool = await getBoxPoolForUser(dbMock.dbRead as never, {
      boxDefinitionId: BOX,
      userId: VIEWER,
      team,
    });
    const odds = computeBoxOdds(
      world.tiers.map(({ id, weight, sortOrder }) => ({ id, weight, sortOrder })),
      pool
    );
    return { pool, tiers: [...odds.tiers].reverse().map((t) => [t.tierId, t.probability]) };
  };

  it.each(['Pink', 'Blue'])("holds Team %s's own pool in its base view", async (team) => {
    const [view] = await catalog();
    const { pool } = await drawnBy(team);
    expect(baseOddsView(view, team).contents.map((c) => c.contentId)).toEqual(
      pool.map((entry) => entry.contentId)
    );
  });

  it('shows the odds every team draws under when they match', async () => {
    const [view] = await catalog();
    const pink = await drawnBy('Pink');
    expect((await drawnBy('Blue')).tiers).toEqual(pink.tiers);
    expect(sharedBaseTierOdds(view)?.map((t) => [t.tier.id, t.probability])).toEqual(pink.tiers);
  });

  it('shows no shared odds when a team draws under different ones', async () => {
    // Without hat 3, Blue has nothing Common: its draw is always the shared Rare hat.
    world.contents = world.contents.filter((c) => c.id !== 3);
    const [view] = await catalog();
    expect((await drawnBy('Blue')).tiers).not.toEqual((await drawnBy('Pink')).tiers);
    expect(sharedBaseTierOdds(view)).toBeNull();
  });

  it('counts an event team with nothing of its own in the box', async () => {
    // Green draws only the shared Rare hat, so its odds differ from Pink's and Blue's.
    mocks.catalogAccess.mockResolvedValue({
      title: 'B',
      teams: ['Pink', 'Blue', 'Green'],
      playable: true,
    });
    const [view] = await catalog();
    expect(view.teams).toEqual(['Pink', 'Blue', 'Green']);
    expect(sharedBaseTierOdds(view)).toBeNull();
  });

  it('shows the odds of an event without teams', async () => {
    mocks.catalogAccess.mockResolvedValue({ title: 'B', teams: [], playable: true });
    world.contents = [hat(1, COMMON), hat(2, COMMON), hat(5, RARE)];
    const [view] = await catalog();
    expect(sharedBaseTierOdds(view)?.map((t) => [t.tier.id, t.probability])).toEqual(
      (await drawnBy(undefined)).tiers
    );
  });

  it("keeps each box's price, tiers and contents to itself, in id order", async () => {
    world.boxes.push(box(SECOND_BOX, { event: EVENT }, 7));
    world.tiers.push(tier(SECOND_TIER, SECOND_BOX, 1, 0));
    world.contents.push(hat(30, SECOND_TIER, undefined, SECOND_BOX));
    world.listings.push(listing({ id: 45, itemDefinitionId: SECOND_BOX, unitAmount: 900 }));

    const views = await catalog();

    expect(
      views.map((v) => ({
        box: v.boxDefinitionId,
        price: v.unitAmount,
        tiers: v.tiers.map((t) => t.id),
        contents: v.contents.map((c) => c.contentId),
      }))
    ).toEqual([
      { box: BOX, price: 500, tiers: [COMMON, RARE], contents: [1, 2, 3, 4, 5] },
      { box: SECOND_BOX, price: 900, tiers: [SECOND_TIER], contents: [30] },
    ]);
  });

  it('shows nothing once the event is no longer playable', async () => {
    mocks.catalogAccess.mockResolvedValue({ title: 'B', teams: ['Pink', 'Blue'], playable: false });
    expect(await catalog()).toEqual([]);
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['not started', { availableFrom: new Date(base + 365 * 86_400_000) }],
    ['ended', { availableTo: new Date(base - 86_400_000) }],
    ['sold out', { availableQuantity: 10, sold: 10 }],
    ['unpublished', { status: 'Unpublished' }],
  ])('leaves out a box whose listing is %s', async (_, change) => {
    world.listings[0] = listing(change);
    expect(await catalog()).toEqual([]);
  });

  it('leaves out an archived box, even one someone holds', async () => {
    world.boxes[0].status = 'archived';
    world.items.push(held(501n));
    expect(await catalog()).toEqual([]);
  });

  it('shows nothing while the event is closed to the viewer', async () => {
    mocks.catalogAccess.mockResolvedValue(null);
    expect(await catalog()).toEqual([]);
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });

  it('shows nothing with boxes off, or in a blocked country', async () => {
    expect(await catalog({ mysteryBoxEnabled: false })).toEqual([]);
    expect(mocks.catalogAccess).not.toHaveBeenCalled();

    world.blocked = ['BE'];
    expect(await catalog({ countryCode: 'BE' })).toEqual([]);
    expect(await catalog({ countryCode: 'US' })).toHaveLength(1);
  });
});
