import type * as EventShopItem from '~/server/events/event-shop-item';
import { computeBoxOdds } from '@civitai/shared/box-odds';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({ mocks: { boxViewer: vi.fn() } }));

vi.mock('~/server/events/event-shop-item', async (importOriginal) => ({
  ...(await importOriginal<typeof EventShopItem>()),
  getEventBoxViewer: mocks.boxViewer,
}));

import {
  countHeldMysteryBoxes,
  getHeldMysteryBoxes,
  getMysteryBoxOpenings,
} from '../mystery-box-inventory.service';
import {
  clearBoxCatalogDisplayCache,
  getBoxPoolForUser,
  getMysteryBoxesForEvent,
} from '../mystery-box.service';
import { boxOddsFor } from '~/components/MysteryBox/mystery-box.utils';
import { dbMock } from '~/__tests__/mocks/db.mock';

const VIEWER = 1;
const OTHER_USER = 2;
const EVENT = 'birthday2026';
const CLOSED_EVENT = 'closed2026';
const EVENT_BOX = 9;
const PLAIN_BOX = 10;
const CLOSED_BOX = 11;
const DRAFT_BOX = 12;
const ARCHIVED_BOX = 13;
const HAT_DEF = 50;
const COMMON = 7;
const RARE = 6;

type Definition = {
  id: number;
  type: string;
  status: string;
  params: unknown;
  version: number;
  name: string;
  description: string | null;
  cosmetic?: { name: string; data: unknown; type: string } | null;
};
type Item = {
  id: bigint;
  itemDefinitionId: number;
  holderType: string;
  holderId: number;
  createdAt: Date;
};
type Opening = {
  boxItemId: bigint;
  boxDefinitionId: number;
  tierId: number;
  rewardDefinitionId: number;
  rewardType: string;
  rewardStatus: string;
  userId: number;
  createdAt: Date;
};

let world: {
  definitions: Definition[];
  items: Item[];
  tiers: {
    id: number;
    boxDefinitionId: number;
    key: string;
    name: string;
    color: string | null;
    weight: number;
    sortOrder: number;
  }[];
  contents: {
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
  }[];
  owned: { userId: number; cosmeticId: number }[];
  openings: Opening[];
  listings: { id: number; itemDefinitionId: number; status: string }[];
  blocked: unknown;
};

const inList = (value: unknown, filter: unknown) =>
  filter && typeof filter === 'object' && 'in' in filter
    ? (filter as { in: unknown[] }).in.includes(value)
    : value === filter;

type Select = { [key: string]: boolean | { select: Select } };
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
const compare = (a: unknown, b: unknown) => (a < b ? -1 : a > b ? 1 : 0);

type Where = Record<string, unknown>;
type Args = {
  where: Where;
  select?: Select;
  orderBy?: Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[];
  take?: number;
  skip?: number;
  cursor?: Record<string, unknown>;
};
function ordered<T extends Record<string, unknown>>(rows: T[], orderBy: Args['orderBy']) {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [[field, dir]] = Object.entries(key);
      const c = compare(a[field], b[field]) * (dir === 'asc' ? 1 : -1);
      if (c) return c;
    }
    return 0;
  });
}
function paged<T extends Record<string, unknown>>(rows: T[], { take, skip, cursor }: Args) {
  let start = 0;
  if (cursor) {
    const [[field, value]] = Object.entries(cursor);
    start = rows.findIndex((row) => row[field] === value);
    if (start < 0) return [];
  }
  start += skip ?? 0;
  return rows.slice(start, take === undefined ? undefined : start + take);
}

function definitionMatches(def: Definition, where: Where) {
  if (where.id !== undefined && !inList(def.id, where.id)) return false;
  if (where.type !== undefined && def.type !== where.type) return false;
  if (where.status !== undefined && !inList(def.status, where.status)) return false;
  const params = where.params as { path: string[]; equals: string } | undefined;
  if (params && (def.params as Record<string, unknown>)?.[params.path[0]] !== params.equals)
    return false;
  return true;
}

function installWorld() {
  const db = dbMock.dbRead;
  db.keyValue.findUnique.mockReset();
  db.keyValue.findUnique.mockImplementation(async () =>
    world.blocked === undefined ? null : { value: world.blocked }
  );
  db.itemDefinition.findMany.mockReset();
  db.itemDefinition.findMany.mockImplementation(async (args: Args) =>
    ordered(
      world.definitions.filter((def) => definitionMatches(def, args.where)),
      args.orderBy
    ).map((def) => project(def, args.select))
  );
  db.item.findMany.mockReset();
  db.item.findMany.mockImplementation(async (args: Args) => {
    const { where } = args;
    const rows = world.items
      .filter(
        (item) =>
          // A filter left out matches every row, as in Prisma.
          (where.holderType === undefined || item.holderType === where.holderType) &&
          (where.holderId === undefined || item.holderId === where.holderId) &&
          (where.itemDefinitionId === undefined ||
            inList(item.itemDefinitionId, where.itemDefinitionId))
      )
      .map((item) => ({
        ...item,
        itemDefinition: world.definitions.find((def) => def.id === item.itemDefinitionId)!,
      }))
      .filter(
        (item) =>
          !where.itemDefinition || definitionMatches(item.itemDefinition, where.itemDefinition)
      );
    return ordered(rows, args.orderBy).map((row) => project(row, args.select));
  });
  db.item.groupBy.mockReset();
  db.item.groupBy.mockImplementation(async ({ where, by }: Args & { by: string[] }) => {
    if (by.join() !== 'itemDefinitionId') throw new Error(`unexpected groupBy ${by.join()}`);
    const counts = new Map<number, number>();
    for (const item of world.items) {
      const def = world.definitions.find((d) => d.id === item.itemDefinitionId)!;
      if (where.holderType !== undefined && item.holderType !== where.holderType) continue;
      if (where.holderId !== undefined && item.holderId !== where.holderId) continue;
      if (where.itemDefinition && !definitionMatches(def, where.itemDefinition as Where)) continue;
      counts.set(item.itemDefinitionId, (counts.get(item.itemDefinitionId) ?? 0) + 1);
    }
    return [...counts].map(([itemDefinitionId, n]) => ({ itemDefinitionId, _count: { _all: n } }));
  });
  db.cosmeticShopItem.findMany.mockReset();
  db.cosmeticShopItem.findMany.mockImplementation(async ({ where }: Args) =>
    world.listings
      .filter(
        (l) => inList(l.itemDefinitionId, where.itemDefinitionId) && l.status === where.status
      )
      .map((l) => ({
        ...l,
        title: 'Listing',
        unitAmount: 500,
        availableQuantity: null,
        availableFrom: null,
        availableTo: null,
      }))
  );
  db.boxTier.findMany.mockReset();
  db.boxTier.findMany.mockImplementation(async (args: Args) =>
    ordered(
      world.tiers.filter(
        (t) =>
          (args.where.boxDefinitionId === undefined ||
            inList(t.boxDefinitionId, args.where.boxDefinitionId)) &&
          (args.where.id === undefined || inList(t.id, args.where.id))
      ),
      args.orderBy
    ).map((t) => project(t, args.select))
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
  db.boxOpening.findMany.mockImplementation(async (args: Args) => {
    const { where } = args;
    const rows = world.openings.filter(
      (o) =>
        (where.userId === undefined || o.userId === where.userId) &&
        (where.boxDefinitionId === undefined || o.boxDefinitionId === where.boxDefinitionId) &&
        (where.rewardType === undefined || o.rewardType === where.rewardType) &&
        (where.rewardStatus === undefined || o.rewardStatus === where.rewardStatus)
    );
    return paged(ordered(rows, args.orderBy), args).map((row) => project(row, args.select));
  });
}

const definition = (
  id: number,
  params: unknown,
  overrides: Partial<Definition> = {}
): Definition => ({
  id,
  type: 'box',
  status: 'published',
  params,
  version: 3,
  name: `Box ${id}`,
  description: null,
  ...overrides,
});
const tier = (id: number, boxDefinitionId: number, weight: number, sortOrder: number) => ({
  id,
  boxDefinitionId,
  key: `t${id}`,
  name: `Tier ${id}`,
  color: null,
  weight,
  sortOrder,
});
const hat = (n: number, boxDefinitionId: number, tierId: number, team?: string) => ({
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
      data: { url: `hat-${n}.png`, ...(team ? { team } : {}) },
      type: 'ContentDecoration',
    },
  },
});
const item = (id: number, itemDefinitionId: number, holderId = VIEWER): Item => ({
  id: BigInt(id),
  itemDefinitionId,
  holderType: 'user',
  holderId,
  createdAt: new Date(`2026-11-0${(id % 9) + 1}T00:00:00Z`),
});
const opening = (boxItemId: number, at: string, overrides: Partial<Opening> = {}): Opening => ({
  boxItemId: BigInt(boxItemId),
  boxDefinitionId: EVENT_BOX,
  tierId: RARE,
  rewardDefinitionId: 101,
  rewardType: 'cosmetic',
  rewardStatus: 'granted',
  userId: VIEWER,
  createdAt: new Date(at),
  ...overrides,
});

const viewer = (overrides: Partial<Parameters<typeof getHeldMysteryBoxes>[0]> = {}) => ({
  userId: VIEWER,
  isModerator: false,
  mysteryBoxEnabled: true,
  countryCode: 'US',
  ...overrides,
});

// The region list is cached for a minute per pod; each case starts past the last one's cache.
const base = new Date('2026-11-08T12:00:00Z').getTime();
let step = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(base + step++ * 5 * 60_000);
  clearBoxCatalogDisplayCache();
  world = {
    // Out of id order throughout: the reads must sort, not inherit the order rows were written in.
    definitions: [
      definition(ARCHIVED_BOX, {}, { status: 'archived' }),
      definition(EVENT_BOX, { event: EVENT }),
      definition(PLAIN_BOX, { emptyRule: 'keep' }),
      definition(CLOSED_BOX, { event: CLOSED_EVENT }),
      definition(DRAFT_BOX, {}, { status: 'draft' }),
      definition(HAT_DEF, {}, { type: 'cosmetic', name: 'Hat 1' }),
      ...[1, 2, 3, 4, 5].map((n) =>
        definition(
          100 + n,
          {},
          {
            type: 'cosmetic',
            cosmetic: {
              name: `Hat ${n}`,
              data: { url: `hat-${n}.png` },
              type: 'ContentDecoration',
            },
          }
        )
      ),
    ],
    items: [
      item(6, ARCHIVED_BOX),
      item(2, EVENT_BOX),
      item(1, EVENT_BOX),
      item(3, PLAIN_BOX),
      item(4, CLOSED_BOX),
      item(5, DRAFT_BOX),
      item(7, HAT_DEF),
      item(8, EVENT_BOX, OTHER_USER),
      // The viewer's id, but held by something other than a user.
      { ...item(10, EVENT_BOX), holderType: 'faction' },
    ],
    tiers: [
      tier(RARE, EVENT_BOX, 1, 1),
      tier(COMMON, EVENT_BOX, 3, 0),
      tier(20, PLAIN_BOX, 1, 0),
      tier(21, ARCHIVED_BOX, 1, 0),
      tier(22, CLOSED_BOX, 1, 0),
    ],
    contents: [
      hat(1, EVENT_BOX, COMMON, 'Pink'),
      hat(2, EVENT_BOX, COMMON, 'Blue'),
      hat(3, EVENT_BOX, RARE),
      hat(4, PLAIN_BOX, 20, 'Pink'),
      hat(5, PLAIN_BOX, 20),
      hat(6, ARCHIVED_BOX, 21),
      hat(7, CLOSED_BOX, 22),
    ],
    owned: [],
    openings: [],
    listings: [{ id: 42, itemDefinitionId: EVENT_BOX, status: 'Published' }],
    blocked: undefined,
  };
  installWorld();
  mocks.boxViewer.mockReset();
  mocks.boxViewer.mockImplementation(async (event: string) =>
    event === EVENT ? { team: 'Pink', playable: true } : null
  );
});

afterAll(() => {
  vi.useRealTimers();
});

describe('getHeldMysteryBoxes', () => {
  it("lists the viewer's held boxes, one view per kind with each held box, event or not", async () => {
    const views = await getHeldMysteryBoxes(viewer());

    expect(
      views.map((v) => ({
        box: v.boxDefinitionId,
        event: v.event,
        team: v.team,
        held: v.heldItems.map((i) => i.id),
      }))
    ).toEqual([
      { box: EVENT_BOX, event: EVENT, team: 'Pink', held: ['1', '2'] },
      { box: PLAIN_BOX, event: null, team: undefined, held: ['3'] },
      // Archived boxes still open; draft ones, other users' boxes and non-box items are not here.
      { box: ARCHIVED_BOX, event: null, team: undefined, held: ['6'] },
    ]);
    expect(views[0].heldBoxItemIds).toEqual(['1', '2']);
    expect(views[0].heldItems[0].acquiredAt).toEqual(
      world.items.find((i) => i.id === 1n)?.createdAt
    );
    expect(views[0].tiers.map((t) => t.id)).toEqual([COMMON, RARE]);
  });

  it('drops a kind whose boxes were all opened between the count and the list', async () => {
    const list = dbMock.dbRead.item.findMany.getMockImplementation()!;
    dbMock.dbRead.item.findMany.mockImplementationOnce(async (args: Args) =>
      ((await list(args)) as { itemDefinitionId: number }[]).filter(
        (row) => row.itemDefinitionId !== PLAIN_BOX
      )
    );

    const views = await getHeldMysteryBoxes(viewer());

    expect(views.map((v) => v.boxDefinitionId)).toEqual([EVENT_BOX, ARCHIVED_BOX]);
  });

  it('asks each event once, as the viewer, moderator bit included', async () => {
    world.definitions.push(definition(14, { event: EVENT }));
    world.items.push(item(9, 14));

    await getHeldMysteryBoxes(viewer({ isModerator: true }));

    expect(mocks.boxViewer.mock.calls).toEqual([
      [EVENT, { id: VIEWER, isModerator: true }],
      [CLOSED_EVENT, { id: VIEWER, isModerator: true }],
    ]);
  });

  it('hides boxes when the blocked-country list is unreadable, and rereads it a minute later', async () => {
    world.blocked = 'DE';

    expect(await getHeldMysteryBoxes(viewer())).toEqual([]);
    expect(await countHeldMysteryBoxes(viewer())).toBe(0);
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    world.blocked = ['DE'];
    expect((await getHeldMysteryBoxes(viewer())).length).toBe(3);
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(2);
  });

  it("leaves out an event's boxes while the event is closed to the viewer", async () => {
    mocks.boxViewer.mockImplementation(async () => null);

    const views = await getHeldMysteryBoxes(viewer());

    expect(views.map((v) => v.boxDefinitionId)).toEqual([PLAIN_BOX, ARCHIVED_BOX]);
    expect(mocks.boxViewer).toHaveBeenCalledWith(EVENT, { id: VIEWER, isModerator: false });
    expect(mocks.boxViewer).toHaveBeenCalledWith(CLOSED_EVENT, { id: VIEWER, isModerator: false });
  });

  it('shows nothing, and reads nothing, with the flag off', async () => {
    expect(await getHeldMysteryBoxes(viewer({ mysteryBoxEnabled: false }))).toEqual([]);
    expect(dbMock.dbRead.item.findMany).not.toHaveBeenCalled();
  });

  it('shows nothing in a blocked country, and nothing when the country is unknown', async () => {
    world.blocked = ['DE'];

    expect(await getHeldMysteryBoxes(viewer({ countryCode: 'DE' }))).toEqual([]);
    expect(await getHeldMysteryBoxes(viewer({ countryCode: null }))).toEqual([]);
    expect((await getHeldMysteryBoxes(viewer({ countryCode: 'US' }))).length).toBe(3);
  });

  it('never offers a box for sale, even one on sale on the event page', async () => {
    const views = await getHeldMysteryBoxes(viewer());

    expect(views.map((v) => v.listing)).toEqual([null, null, null]);
  });

  it("shows a box with no event only what its open can draw: no team's cosmetics", async () => {
    const [, plain] = await getHeldMysteryBoxes(viewer());

    expect(plain.contents.map((c) => c.cosmeticId)).toEqual([1005]);
  });

  // Pins what the Inventory hands the shared view builder (team, viewer, held boxes): the odds rule
  // itself is the same function on both sides, so this does not prove the draw's odds on its own.
  it("hands the shared builder the event page's arguments for an event box", async () => {
    world.owned = [{ userId: VIEWER, cosmeticId: 1001 }];
    const [held] = await getHeldMysteryBoxes(viewer());
    const [onEventPage] = await getMysteryBoxesForEvent({ ...viewer(), event: EVENT });

    const { event: _event, heldItems: _items, ...heldView } = held;
    expect(heldView).toEqual({ ...onEventPage, listing: null });
    expect(heldView.contents.map((c) => [c.cosmeticId, c.left])).toEqual([
      [1001, false],
      [1003, true],
    ]);

    const pool = await getBoxPoolForUser(dbMock.dbRead, {
      boxDefinitionId: EVENT_BOX,
      userId: VIEWER,
      team: 'Pink',
    });
    const tiers = world.tiers.filter((t) => t.boxDefinitionId === EVENT_BOX);
    expect(boxOddsFor(held)).toEqual(computeBoxOdds(tiers, pool));
  });

  it("shows a box with no event the odds its open draws from (no team's pool)", async () => {
    const [, plain] = await getHeldMysteryBoxes(viewer());
    const pool = await getBoxPoolForUser(dbMock.dbRead, {
      boxDefinitionId: PLAIN_BOX,
      userId: VIEWER,
      team: undefined,
    });

    expect(boxOddsFor(plain)).toEqual(
      computeBoxOdds(
        world.tiers.filter((t) => t.boxDefinitionId === PLAIN_BOX),
        pool
      )
    );
  });
});

describe('countHeldMysteryBoxes', () => {
  it('counts the boxes the Inventory lists', async () => {
    expect(await countHeldMysteryBoxes(viewer())).toBe(4);

    mocks.boxViewer.mockImplementation(async () => null);
    expect(await countHeldMysteryBoxes(viewer())).toBe(2);
  });

  it('is 0 with the flag off or in a blocked country', async () => {
    expect(await countHeldMysteryBoxes(viewer({ mysteryBoxEnabled: false }))).toBe(0);
    world.blocked = ['DE'];
    expect(await countHeldMysteryBoxes(viewer({ countryCode: 'DE' }))).toBe(0);
  });

  it('is 0 for someone holding no boxes, with no event lookup', async () => {
    world.items = world.items.filter((i) => i.holderId !== VIEWER);

    expect(await countHeldMysteryBoxes(viewer())).toBe(0);
    expect(mocks.boxViewer).not.toHaveBeenCalled();
  });
});

describe('getMysteryBoxOpenings', () => {
  beforeEach(() => {
    world.openings = [
      opening(31, '2026-11-01T00:00:00Z'),
      opening(32, '2026-11-03T00:00:00Z', { tierId: COMMON, rewardDefinitionId: 102 }),
      opening(33, '2026-11-02T00:00:00Z', { boxDefinitionId: PLAIN_BOX, tierId: 20 }),
      opening(34, '2026-11-04T00:00:00Z', { userId: OTHER_USER }),
    ];
  });

  it("lists the viewer's opens newest first, with the reward, its rarity and its box", async () => {
    const { items, nextCursor } = await getMysteryBoxOpenings({ ...viewer(), limit: 10 });

    expect(nextCursor).toBeUndefined();
    expect(items.map((o) => o.boxItemId)).toEqual(['32', '33', '31']);
    expect(items[0]).toEqual({
      boxItemId: '32',
      openedAt: new Date('2026-11-03T00:00:00Z'),
      box: { id: EVENT_BOX, name: `Box ${EVENT_BOX}` },
      tier: { id: COMMON, name: `Tier ${COMMON}`, color: null, sortOrder: 0 },
      reward: { name: 'Hat 2', url: 'hat-2.png', cosmeticType: 'ContentDecoration' },
    });
    expect(items[1].box).toEqual({ id: PLAIN_BOX, name: `Box ${PLAIN_BOX}` });
  });

  it('leaves out an open a moderator refunded: its reward was taken back', async () => {
    world.openings.push(opening(35, '2026-11-05T00:00:00Z', { rewardStatus: 'refunded' }));

    const { items } = await getMysteryBoxOpenings({ ...viewer(), limit: 10 });

    expect(items.map((o) => o.boxItemId)).toEqual(['32', '33', '31']);
  });

  it('pages through every open once', async () => {
    const first = await getMysteryBoxOpenings({ ...viewer(), limit: 2 });
    const second = await getMysteryBoxOpenings({
      ...viewer(),
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.items.map((o) => o.boxItemId)).toEqual(['32', '33']);
    expect(first.nextCursor).toBe('33');
    expect(second.items.map((o) => o.boxItemId)).toEqual(['31']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('answers an opening whose box, tier or reward is gone with nulls', async () => {
    world.openings = [
      opening(51, '2026-11-06T00:00:00Z', {
        boxDefinitionId: 999,
        tierId: 999,
        rewardDefinitionId: 999,
      }),
    ];

    const { items } = await getMysteryBoxOpenings({ ...viewer(), limit: 10 });

    expect(items).toEqual([
      {
        boxItemId: '51',
        openedAt: new Date('2026-11-06T00:00:00Z'),
        box: null,
        tier: null,
        reward: null,
      },
    ]);
  });

  it('offers no next page when the last page is exactly full', async () => {
    const page = await getMysteryBoxOpenings({ ...viewer(), limit: 3 });

    expect(page.items.map((o) => o.boxItemId)).toEqual(['32', '33', '31']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('pages opens made in the same instant by id, each once', async () => {
    world.openings = [
      opening(41, '2026-11-05T00:00:00Z'),
      opening(42, '2026-11-05T00:00:00Z'),
      opening(43, '2026-11-05T00:00:00Z'),
    ];
    const first = await getMysteryBoxOpenings({ ...viewer(), limit: 2 });
    const second = await getMysteryBoxOpenings({ ...viewer(), limit: 2, cursor: first.nextCursor });

    expect([...first.items, ...second.items].map((o) => o.boxItemId)).toEqual(['43', '42', '41']);
  });

  it('shows nothing, and reads nothing, with the flag off or in a blocked country', async () => {
    expect(
      await getMysteryBoxOpenings({ ...viewer({ mysteryBoxEnabled: false }), limit: 10 })
    ).toEqual({ items: [], nextCursor: undefined });
    world.blocked = ['DE'];
    expect(await getMysteryBoxOpenings({ ...viewer({ countryCode: 'DE' }), limit: 10 })).toEqual({
      items: [],
      nextCursor: undefined,
    });
    expect(dbMock.dbRead.boxOpening.findMany).not.toHaveBeenCalled();
  });
});
