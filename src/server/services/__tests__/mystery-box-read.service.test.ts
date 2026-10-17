import type * as EventShopItem from '~/server/events/event-shop-item';
import { computeBoxOdds } from '@civitai/shared/box-odds';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// What the event page shows of an event's mystery boxes: which boxes, what each holds for the
// viewer's team, what is still left for them, and the boxes they hold. The odds the page shows are
// `computeBoxOdds` over the left contents, the rule and the pool the open draws from.

const { mocks } = vi.hoisted(() => ({ mocks: { viewerTeam: vi.fn() } }));

vi.mock('~/server/events/event-shop-item', async (importOriginal) => ({
  ...(await importOriginal<typeof EventShopItem>()),
  getEventViewerTeam: mocks.viewerTeam,
}));

import { getBoxPoolForUser, getMysteryBoxesForEvent } from '../mystery-box.service';
import { boxOddsFor } from '~/components/MysteryBox/mystery-box.utils';
import { dbMock } from '~/__tests__/mocks/db.mock';

const VIEWER = 1;
const EVENT = 'birthday2026';
const BOX = 9;
const OLD_BOX = 10;
const OTHER_EVENT_BOX = 11;
const COMMON = 7;
const RARE = 6;

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

let world: {
  boxes: { id: number; type: string; status: string; params: unknown; version: number }[];
  listings: {
    id: number;
    itemDefinitionId: number;
    status: string;
    availableQuantity: number | null;
    availableFrom: Date | null;
    availableTo: Date | null;
    purchases: number;
  }[];
  tiers: { id: number; boxDefinitionId: number; weight: number; sortOrder: number }[];
  contents: Content[];
  owned: { userId: number; cosmeticId: number }[];
  drawn: { userId: number; boxDefinitionId: number; rewardDefinitionId: number }[];
  items: { id: bigint; itemDefinitionId: number; holderType: string; holderId: number }[];
  blocked: unknown;
};

const inList = (value: unknown, filter: unknown) =>
  filter && typeof filter === 'object' && 'in' in filter
    ? (filter as { in: unknown[] }).in.includes(value)
    : value === filter;

function installWorld() {
  const db = dbMock.dbRead;
  db.keyValue.findUnique.mockReset();
  db.keyValue.findUnique.mockImplementation(async () =>
    world.blocked === undefined ? null : { value: world.blocked }
  );
  db.itemDefinition.findMany.mockReset();
  db.itemDefinition.findMany.mockImplementation(
    async ({ where }: { where: { type: string; status: unknown; params: { equals: string } } }) =>
      world.boxes
        .filter(
          (b) =>
            b.type === where.type &&
            inList(b.status, where.status) &&
            (b.params as { event?: string }).event === where.params.equals
        )
        .map((b) => ({ ...b, name: `Box ${b.id}`, description: null }))
  );
  db.cosmeticShopItem.findMany.mockReset();
  db.cosmeticShopItem.findMany.mockImplementation(
    async ({ where }: { where: { itemDefinitionId: unknown; status: string } }) =>
      world.listings
        .filter((l) => inList(l.itemDefinitionId, where.itemDefinitionId))
        .filter((l) => l.status === where.status)
        .map((l) => ({
          ...l,
          title: `Listing ${l.id}`,
          unitAmount: 500,
          _count: { purchases: l.purchases },
        }))
  );
  db.item.findMany.mockReset();
  db.item.findMany.mockImplementation(
    async ({
      where,
    }: {
      where: { holderType: string; holderId: number; itemDefinitionId: unknown };
    }) =>
      world.items.filter(
        (i) =>
          i.holderType === where.holderType &&
          i.holderId === where.holderId &&
          inList(i.itemDefinitionId, where.itemDefinitionId)
      )
  );
  db.boxTier.findMany.mockReset();
  db.boxTier.findMany.mockImplementation(
    async ({ where }: { where: { boxDefinitionId: unknown } }) =>
      world.tiers
        .filter((t) => inList(t.boxDefinitionId, where.boxDefinitionId))
        .map((t) => ({ ...t, key: `t${t.id}`, name: `Tier ${t.id}`, color: null }))
  );
  db.boxContent.findMany.mockReset();
  db.boxContent.findMany.mockImplementation(
    async ({ where }: { where: { boxDefinitionId: number; enabled: boolean } }) =>
      world.contents.filter(
        (c) => c.boxDefinitionId === where.boxDefinitionId && c.enabled === where.enabled
      )
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
    async ({ where }: { where: { userId: number; boxDefinitionId: number } }) =>
      world.drawn.filter(
        (d) => d.userId === where.userId && d.boxDefinitionId === where.boxDefinitionId
      )
  );
}

const read = (
  overrides: Partial<Parameters<typeof getMysteryBoxesForEvent>[0]> = {}
): ReturnType<typeof getMysteryBoxesForEvent> =>
  getMysteryBoxesForEvent({
    userId: VIEWER,
    event: EVENT,
    mysteryBoxEnabled: true,
    countryCode: 'US',
    ...overrides,
  });

const listing = (overrides: Partial<(typeof world.listings)[number]> = {}) => ({
  id: 42,
  itemDefinitionId: BOX,
  status: 'Published',
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  purchases: 0,
  ...overrides,
});

// The region list is cached for a minute per pod; each case starts past the last one's cache.
const base = new Date('2026-11-08T12:00:00Z').getTime();
let step = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(base + step++ * 5 * 60_000);
  world = {
    boxes: [
      { id: BOX, type: 'box', status: 'published', params: { event: EVENT }, version: 3 },
      {
        id: OTHER_EVENT_BOX,
        type: 'box',
        status: 'published',
        params: { event: 'other' },
        version: 1,
      },
    ],
    listings: [listing(), listing({ id: 43, itemDefinitionId: OTHER_EVENT_BOX })],
    tiers: [
      { id: COMMON, boxDefinitionId: BOX, weight: 3, sortOrder: 0 },
      { id: RARE, boxDefinitionId: BOX, weight: 1, sortOrder: 1 },
    ],
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
  mocks.viewerTeam.mockReset();
  mocks.viewerTeam.mockResolvedValue('Pink');
});

afterAll(() => {
  vi.useRealTimers();
});

describe('getMysteryBoxesForEvent', () => {
  it("shows the event's box on sale, with what it holds for the viewer's team", async () => {
    const [view, ...rest] = await read();

    expect(rest).toEqual([]);
    expect(view.boxDefinitionId).toBe(BOX);
    expect(view.version).toBe(3);
    expect(view.listing).toEqual({
      shopItemId: 42,
      title: 'Listing 42',
      unitAmount: 500,
      availableTo: null,
    });
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
    expect(view.heldBoxItemIds).toEqual([]);
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
  });

  it("lists the viewer's unopened boxes, not anyone else's", async () => {
    world.items.push(
      { id: 501n, itemDefinitionId: BOX, holderType: 'user', holderId: VIEWER },
      { id: 502n, itemDefinitionId: BOX, holderType: 'user', holderId: 2 },
      { id: 503n, itemDefinitionId: BOX, holderType: 'user', holderId: VIEWER }
    );

    const [view] = await read();

    expect(view.heldBoxItemIds).toEqual(['501', '503']);
  });

  it.each([
    ['not started', { availableFrom: new Date(base + 365 * 86_400_000) }],
    ['ended', { availableTo: new Date(base - 86_400_000) }],
    ['sold out', { availableQuantity: 10, purchases: 10 }],
    ['unpublished', { status: 'Unpublished' }],
  ])('leaves out a box whose listing is %s, unless the viewer holds one', async (_, change) => {
    world.listings[0] = listing(change);
    expect(await read()).toEqual([]);

    world.items.push({ id: 501n, itemDefinitionId: BOX, holderType: 'user', holderId: VIEWER });
    const [view] = await read();
    expect(view.listing).toBeNull();
    expect(view.heldBoxItemIds).toEqual(['501']);
  });

  it('still shows an archived box the viewer holds, never for sale', async () => {
    world.boxes[0].status = 'archived';
    expect(await read()).toEqual([]);

    world.items.push({ id: 501n, itemDefinitionId: BOX, holderType: 'user', holderId: VIEWER });
    const [view] = await read();
    expect(view.listing).toBeNull();
  });

  it('shows nothing with boxes off', async () => {
    expect(await read({ mysteryBoxEnabled: false })).toEqual([]);
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
    await read({ countryCode: 'BE' });
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(1);

    // A change shows after the minute.
    world.blocked = ['US'];
    vi.setSystemTime(Date.now() + 61_000);
    expect(await read({ countryCode: 'US' })).toEqual([]);
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(2);
  });

  it("shows nothing when the viewer's team can't be read", async () => {
    mocks.viewerTeam.mockResolvedValue(null);
    expect(await read()).toEqual([]);
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

    mocks.viewerTeam.mockResolvedValue('Green');
    expect((await read())[0].art).toBeNull();
  });
});
