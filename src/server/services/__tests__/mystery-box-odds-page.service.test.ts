import type * as EventShopItem from '~/server/events/event-shop-item';
import { computeBoxOdds } from '@civitai/shared/box-odds';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The public odds page of a mystery box: shown only where boxes are, its odds the draw's own rule
// over the live contents, and its history worded from the stored snapshots.

const { mocks } = vi.hoisted(() => ({ mocks: { catalogAccess: vi.fn() } }));

vi.mock('~/server/events/event-shop-item', async (importOriginal) => ({
  ...(await importOriginal<typeof EventShopItem>()),
  getEventBoxCatalogAccess: mocks.catalogAccess,
}));

import type { BoxOddsSnapshotData } from '@civitai/shared/box-odds-snapshot';
import { snapshotOfLiveBox, snapshotsMatch } from '@civitai/shared/box-odds-snapshot';
import { describeSnapshotChange, getMysteryBoxOddsPage } from '../mystery-box-odds-page.service';
import { clearBoxCatalogDisplayCache, getBoxPoolForUser } from '../mystery-box.service';
import { baseOddsView, tierSummaries } from '~/components/MysteryBox/mystery-box.utils';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const EVENT = 'birthday2026';
const BOX = 9;
// Ids run against draw order, so an id-ordered walk shows.
const COMMON = 7;
const RARE = 6;

const hat = (n: number, tierId: number, team?: string, enabled = true) => ({
  id: n,
  boxDefinitionId: BOX,
  tierId,
  rewardDefinitionId: 100 + n,
  enabled,
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

const TIERS = [
  {
    id: COMMON,
    boxDefinitionId: BOX,
    key: 'common',
    name: 'Common',
    color: null,
    weight: 3,
    sortOrder: 0,
  },
  {
    id: RARE,
    boxDefinitionId: BOX,
    key: 'rare',
    name: 'Rare',
    color: '#3b82f6',
    weight: 1,
    sortOrder: 1,
  },
];

/**
 * A v1 snapshot of the world below in the writer's shape: tiers in draw order, contents by tier then
 * cosmetic. `boxOddsSnapshotSchema` is the contract any snapshot writer must meet.
 */
const seedSnapshot = (): BoxOddsSnapshotData => ({
  tiers: [
    { key: 'common', name: 'Common', weight: 3 },
    { key: 'rare', name: 'Rare', weight: 1 },
  ],
  contents: [
    { tier: 'common', cosmeticId: 1001 },
    { tier: 'common', cosmeticId: 1002 },
    { tier: 'common', cosmeticId: 1003 },
    { tier: 'rare', cosmeticId: 1004 },
    { tier: 'rare', cosmeticId: 1005 },
  ],
});

const OTHER_BOX = 12;
const OTHER_TIER = { ...TIERS[0], id: 30, boxDefinitionId: OTHER_BOX, key: 'x', name: 'X' };
const boxContents = () => world.contents.filter((c) => c.boxDefinitionId === BOX);

type Box = {
  id: number;
  type: string;
  status: string;
  version: number;
  name: string;
  description: string | null;
  params: unknown;
};
type Listing = {
  id: number;
  itemDefinitionId: number;
  status: string;
  unitAmount: number;
  availableQuantity: number | null;
  availableFrom: Date | null;
  availableTo: Date | null;
  /** Purchase rows, read through the sold-count query. */
  sold: number;
};
const listing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 42,
  itemDefinitionId: BOX,
  status: 'Published',
  unitAmount: 500,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  sold: 0,
  ...overrides,
});

let world: {
  boxes: Box[];
  tiers: typeof TIERS;
  contents: ReturnType<typeof hat>[];
  snapshots: { boxDefinitionId: number; version: number; snapshot: unknown; createdAt: Date }[];
  listings: Listing[];
  items: {
    id: bigint;
    itemDefinitionId: number;
    holderType: string;
    holderId: number;
    quantity: number;
  }[];
  openings: { boxItemId: bigint; boxDefinitionId: number; userId: number }[];
  purchases: { buzzTransactionId: string; shopItemId: number; refunded: boolean }[];
  blocked: unknown;
  owned: { userId: number; cosmeticId: number }[];
};
const theBox = () => world.boxes.find((b) => b.id === BOX)!;

// A fake that answers only what the query asks: rows matching `where` (equality or `in`), sorted by
// `orderBy`, projected to `select`. A query that drops a filter, an order or a column sees it here.
type Select = { [key: string]: boolean | { select: Select } };
type Query = { where?: Record<string, unknown>; select?: Select; orderBy?: unknown };
function project(row: Record<string, unknown>, select: Select): Record<string, unknown> {
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
// An undefined value filters nothing, as in Prisma.
const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([key, want]) =>
    want === undefined
      ? true
      : want && typeof want === 'object' && 'in' in want
      ? (want as { in: unknown[] }).in.includes(row[key])
      : row[key] === want
  );
function answer<T extends object>(rows: T[], { where, select, orderBy }: Query, ordered = false) {
  if (!select) throw new Error('query without a select');
  if (ordered && !orderBy) throw new Error('query without an order');
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map(
    (o) => Object.entries(o as Record<string, 'asc' | 'desc'>)[0]
  );
  return rows
    .filter((row) => matches(row as Record<string, unknown>, where))
    .sort((a, b) => {
      for (const [key, dir] of keys) {
        const x = (a as Record<string, number>)[key];
        const y = (b as Record<string, number>)[key];
        if (x !== y) return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1);
      }
      return 0;
    })
    .map((row) => project(row as Record<string, unknown>, select));
}

function installWorld() {
  const db = dbMock.dbRead;
  db.keyValue.findUnique.mockReset();
  db.keyValue.findUnique.mockImplementation(async () =>
    world.blocked === undefined ? null : { value: world.blocked }
  );
  db.itemDefinition.findUnique.mockReset();
  db.itemDefinition.findUnique.mockImplementation(
    async (q: Query) => answer(world.boxes, q)[0] ?? null
  );
  db.boxTier.findMany.mockReset();
  db.boxTier.findMany.mockImplementation(async (q: Query) => answer(world.tiers, q, true));
  db.boxContent.findMany.mockReset();
  db.boxContent.findMany.mockImplementation(async (q: Query) => answer(world.contents, q));
  db.boxOddsSnapshot.findMany.mockReset();
  db.boxOddsSnapshot.findMany.mockImplementation(async (q: Query) =>
    answer(world.snapshots, q, true)
  );
  db.cosmeticShopItem.findMany.mockReset();
  db.cosmeticShopItem.findMany.mockImplementation(async (q: Query) =>
    answer(world.listings, q, true)
  );
  db.$queryRaw.mockReset();
  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join('?').includes('"UserCosmeticShopPurchases"')) throw new Error('unexpected');
    const ids = values[0] as number[];
    return world.listings
      .filter((l) => ids.includes(l.id) && l.sold > 0)
      .map((l) => ({ shopItemId: l.id, sold: l.sold }));
  });
  db.item.aggregate.mockReset();
  db.item.aggregate.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const rows = world.items.filter((item) => matches(item, where));
    return {
      _sum: { quantity: rows.length ? rows.reduce((n, item) => n + item.quantity, 0) : null },
    };
  });
  db.userCosmeticShopPurchases.findFirst.mockReset();
  db.userCosmeticShopPurchases.findFirst.mockImplementation(
    async (q: Query) => answer(world.purchases, q)[0] ?? null
  );
  db.boxOpening.findFirst.mockReset();
  db.boxOpening.findFirst.mockImplementation(
    async (q: Query) => answer(world.openings, q)[0] ?? null
  );
  db.userCosmetic.findMany.mockReset();
  db.userCosmetic.findMany.mockImplementation(
    async ({ where }: { where: { userId: number; cosmeticId: { in: number[] } } }) =>
      world.owned.filter(
        (o) => o.userId === where.userId && where.cosmeticId.in.includes(o.cosmeticId)
      )
  );
  db.boxOpening.findMany.mockReset();
  db.boxOpening.findMany.mockImplementation(async () => []);
}

const read = (overrides: Partial<Parameters<typeof getMysteryBoxOddsPage>[0]> = {}) =>
  getMysteryBoxOddsPage({
    boxDefinitionId: BOX,
    viewer: undefined,
    mysteryBoxEnabled: true,
    countryCode: 'US',
    ...overrides,
  });

const errorsLogged = () =>
  loggingMock.logToAxiom.mock.calls
    .map(
      ([entry]) =>
        entry as {
          type?: string;
          name?: string;
          message?: string;
          boxDefinitionId?: number;
          version?: number;
        }
    )
    .filter((entry) => entry.type === 'error' && entry.name === 'mystery-box-odds-page');

// The region list is cached for a minute per pod; each case starts past the last one's cache.
const base = new Date('2026-11-08T12:00:00Z').getTime();
let step = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(base + step++ * 5 * 60_000);
  clearBoxCatalogDisplayCache();
  world = {
    boxes: [
      {
        id: BOX,
        type: 'box',
        status: 'published',
        version: 1,
        name: 'Birthday Box',
        description: 'A hat from your team.',
        params: { event: EVENT },
      },
      // Another box, with its own history and listing: neither may show on this box's page.
      {
        id: OTHER_BOX,
        type: 'box',
        status: 'published',
        version: 1,
        name: 'Other Box',
        description: null,
        params: { event: EVENT },
      },
    ],
    tiers: [...TIERS, OTHER_TIER],
    contents: [
      hat(1, COMMON, 'Pink'),
      hat(2, COMMON, 'Pink'),
      hat(3, COMMON, 'Blue'),
      hat(4, RARE, 'Pink'),
      hat(5, RARE),
      { ...hat(20, OTHER_TIER.id, 'Pink'), boxDefinitionId: OTHER_BOX },
    ],
    snapshots: [
      {
        boxDefinitionId: OTHER_BOX,
        version: 1,
        snapshot: { tiers: [{ key: 'x', name: 'X', weight: 1 }], contents: [] },
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        boxDefinitionId: BOX,
        version: 1,
        snapshot: seedSnapshot(),
        createdAt: new Date('2026-11-06T10:00:00Z'),
      },
    ],
    listings: [listing(), listing({ id: 43, itemDefinitionId: OTHER_BOX, unitAmount: 900 })],
    items: [],
    openings: [],
    purchases: [],
    blocked: undefined,
    owned: [],
  };
  installWorld();
  mocks.catalogAccess.mockReset();
  mocks.catalogAccess.mockResolvedValue({
    title: "Civitai's 4th Birthday",
    teams: ['Yellow', 'Blue', 'Pink', 'Green'],
  });
  loggingMock.logToAxiom.mockClear();
});

afterAll(() => {
  vi.useRealTimers();
});

describe('who sees the odds page', () => {
  it('shows a published box to a signed-out visitor the event is open to', async () => {
    const page = await read();
    expect(page).toMatchObject({
      boxDefinitionId: BOX,
      name: 'Birthday Box',
      description: 'A hat from your team.',
      version: 1,
      archived: false,
    });
    // Only this box's tiers and contents, with what the page draws them by.
    expect(page?.tiers.map((t) => [t.id, t.key, t.name, t.color, t.weight])).toEqual([
      [COMMON, 'common', 'Common', null, 3],
      [RARE, 'rare', 'Rare', '#3b82f6', 1],
    ]);
    expect(page?.contents.map((c) => c.contentId)).toEqual([1, 2, 3, 4, 5]);
    expect(page?.contents[0]).toEqual({
      contentId: 1,
      tierId: COMMON,
      cosmeticId: 1001,
      name: 'Hat 1',
      url: 'hat-1.png',
      fit: null,
      team: 'Pink',
    });
    expect(mocks.catalogAccess).toHaveBeenCalledWith(EVENT, undefined);
  });

  it('asks the event about the signed-in viewer', async () => {
    await read({ viewer: { id: 5, isModerator: true } });
    expect(mocks.catalogAccess).toHaveBeenCalledWith(EVENT, { id: 5, isModerator: true });
  });

  it('shows nothing while the event is closed to the viewer', async () => {
    mocks.catalogAccess.mockResolvedValue(null);
    expect(await read()).toBeNull();
  });

  it('shows nothing with boxes off', async () => {
    expect(await read({ mysteryBoxEnabled: false })).toBeNull();
    expect(dbMock.dbRead.itemDefinition.findUnique).not.toHaveBeenCalled();
  });

  it('shows nothing in a blocked country, nor to a visitor with no known country', async () => {
    world.blocked = ['BE'];
    expect(await read({ countryCode: 'BE' })).toBeNull();
    expect(await read({ countryCode: null })).toBeNull();
    expect(await read({ countryCode: undefined })).toBeNull();
    expect(await read({ countryCode: 'US' })).not.toBeNull();
  });

  it('shows a draft box to nobody, moderators included', async () => {
    theBox().status = 'draft';
    expect(await read()).toBeNull();
    expect(await read({ viewer: { id: 5, isModerator: true } })).toBeNull();
  });

  it('shows an archived box, marked as no longer sold', async () => {
    theBox().status = 'archived';
    expect((await read())?.archived).toBe(true);
  });

  it('is not a page for anything but a box', async () => {
    theBox().type = 'cosmetic';
    expect(await read()).toBeNull();
    expect(await read({ boxDefinitionId: 999 })).toBeNull();
  });

  it('needs no event for a box without one', async () => {
    theBox().params = {};
    world.contents = boxContents().map((c) => hat(c.id, c.tierId));
    const page = await read();
    expect(page?.event).toBeNull();
    expect(page?.teams).toEqual([]);
    expect(mocks.catalogAccess).not.toHaveBeenCalled();
  });
});

describe('before the box goes on sale', () => {
  const MOD = { id: 5, isModerator: true };
  const HOLDER = { id: 6, isModerator: false };
  const STRANGER = { id: 7, isModerator: false };
  const nextWeek = () => new Date(Date.now() + 7 * 24 * 3600_000);
  const heldBy = (userId: number, itemDefinitionId = BOX, id = 501n) => ({
    id,
    itemDefinitionId,
    holderType: 'user',
    holderId: userId,
    quantity: 1,
  });

  it('hides a box whose only listing opens later, except from moderators', async () => {
    world.listings = [listing({ availableFrom: nextWeek() })];
    expect(await read()).toBeNull();
    expect(await read({ viewer: STRANGER })).toBeNull();
    expect((await read({ viewer: MOD }))?.price).toBeNull();
  });

  it("hides a box with no published listing, and isn't fooled by another box's or a draft listing", async () => {
    world.listings = [
      listing({ status: 'Draft' }),
      listing({ id: 43, itemDefinitionId: OTHER_BOX, unitAmount: 900 }),
    ];
    expect(await read()).toBeNull();
  });

  it('shows a box granted before its sale to its holder, and to no one else', async () => {
    world.listings = [listing({ availableFrom: nextWeek() })];
    world.items = [heldBy(HOLDER.id)];
    expect(await read({ viewer: HOLDER })).not.toBeNull();
    expect(await read({ viewer: STRANGER })).toBeNull();
    expect(await read()).toBeNull();
  });

  it('shows it to a viewer who has opened one, and to no one else', async () => {
    world.listings = [];
    world.openings = [{ boxItemId: 503n, boxDefinitionId: BOX, userId: HOLDER.id }];
    expect(await read({ viewer: HOLDER })).not.toBeNull();
    expect(await read({ viewer: STRANGER })).toBeNull();
  });

  it("isn't opened up by what the viewer holds of another box, or by an id-less viewer", async () => {
    world.listings = [];
    world.items = [heldBy(HOLDER.id, OTHER_BOX, 502n)];
    world.openings = [{ boxItemId: 504n, boxDefinitionId: OTHER_BOX, userId: HOLDER.id }];
    expect(await read({ viewer: HOLDER })).toBeNull();
    world.items = [heldBy(HOLDER.id)];
    expect(await read({ viewer: { isModerator: false } })).toBeNull();
  });

  it('shows it to anyone once one was bought, from a listing no longer on sale', async () => {
    world.listings = [listing({ status: 'Archived', availableFrom: nextWeek() })];
    expect(await read()).toBeNull();
    world.purchases = [
      { buzzTransactionId: 'item-purchase-v1-a', shopItemId: 42, refunded: false },
    ];
    expect(await read({ viewer: STRANGER })).not.toBeNull();
    expect(await read()).not.toBeNull();
  });

  // A refund does not un-publish a page already disclosed.
  it('counts a refunded purchase as a sale', async () => {
    world.listings = [listing({ status: 'Archived' })];
    expect(await read()).toBeNull();
    world.purchases = [{ buzzTransactionId: 'item-purchase-v1-r', shopItemId: 42, refunded: true }];
    expect(await read()).not.toBeNull();
  });

  it("isn't opened up by a purchase of another box", async () => {
    world.listings = [
      listing({ status: 'Archived' }),
      listing({ id: 43, itemDefinitionId: OTHER_BOX }),
    ];
    world.purchases = [
      { buzzTransactionId: 'item-purchase-v1-b', shopItemId: 43, refunded: false },
    ];
    expect(await read()).toBeNull();
  });

  it('shows it, priced, once its listing window has opened', async () => {
    world.listings = [listing({ availableFrom: new Date(Date.now() - 3600_000) })];
    expect((await read())?.price).toBe(500);
    world.listings = [listing({ availableFrom: new Date(Date.now()) })];
    expect((await read())?.price).toBe(500);
  });

  it('shows a listing whose window has opened, even sold out or ended, without a price', async () => {
    world.listings = [listing({ availableQuantity: 10, sold: 10 })];
    expect(await read()).toMatchObject({ price: null });
    world.listings = [listing({ availableTo: new Date(Date.now() - 1000) })];
    expect(await read()).toMatchObject({ price: null });
  });
});

describe('what the odds page shows', () => {
  it("lists the event's teams that the box holds anything for, in the event's order", async () => {
    const page = await read();
    expect(page?.teams).toEqual(['Blue', 'Pink']);
    expect(page?.event).toEqual({ title: "Civitai's 4th Birthday" });
    expect(page?.noun).toBe('hat');
  });

  it("lists a team the event doesn't, so its hats are never pooled with another's", async () => {
    mocks.catalogAccess.mockResolvedValue({ title: 'Event', teams: ['Pink'] });
    expect((await read())?.teams).toEqual(['Pink', 'Blue']);
  });

  it("prices the box by this box's listing on sale now", async () => {
    world.listings = [
      listing({ id: 40, unitAmount: 300, availableFrom: new Date(Date.now() + 3600_000) }),
      listing({ id: 41, unitAmount: 400, status: 'Unpublished' }),
      listing({ id: 42, unitAmount: 500 }),
      listing({ id: 43, itemDefinitionId: OTHER_BOX, unitAmount: 900 }),
    ];
    expect((await read())?.price).toBe(500);
  });

  it('has no price for an archived box', async () => {
    theBox().status = 'archived';
    expect((await read())?.price).toBeNull();
  });

  it('leaves out disabled contents', async () => {
    world.contents.push(hat(6, RARE, 'Pink', false));
    const page = await read();
    expect(page?.contents.map((c) => c.contentId)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads the contents once per box version, and a bump shows the new version's", async () => {
    await read();
    world.contents.push(hat(6, RARE, 'Pink'));
    expect((await read())?.contents.map((c) => c.contentId)).toEqual([1, 2, 3, 4, 5]);
    expect(dbMock.dbRead.boxContent.findMany).toHaveBeenCalledTimes(1);

    world.boxes[0].version = 2;
    expect((await read())?.contents.map((c) => c.contentId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('calls the contents items when any is not a hat', async () => {
    world.contents[0].reward.cosmetic.type = 'Badge';
    expect((await read())?.noun).toBe('item');
  });

  it('calls a content decoration that belongs to no event an item, not a hat', async () => {
    world.contents[0].reward.cosmetic.data = { url: 'frame.png' } as never;
    expect((await read())?.noun).toBe('item');
  });

  // Same source: the odds the page shows a team are the odds the draw would run for a member of
  // that team who owns nothing yet.
  it.each(['Pink', 'Blue'])(
    "shows Team %s the draw's own odds for a buyer who owns nothing",
    async (team) => {
      const page = (await read())!;
      const shown = tierSummaries(baseOddsView(page, team));
      const pool = await getBoxPoolForUser(dbMock.dbRead, {
        boxDefinitionId: BOX,
        userId: 77,
        team,
      });
      const drawn = computeBoxOdds(TIERS, pool);
      expect(
        shown
          .filter((t) => t.probability > 0)
          .map((t) => [
            t.tier.id,
            t.probability,
            t.itemProbability,
            t.contents.map((c) => c.contentId),
          ])
          .sort()
      ).toEqual(
        drawn.tiers.map((t) => [t.tierId, t.probability, t.itemProbability, t.contentIds]).sort()
      );
    }
  );

  it('gives a team with no rare hats all of the chance in common', async () => {
    const blue = tierSummaries(baseOddsView((await read())!, 'Blue'));
    // Blue has one common hat of its own and the teamless rare hat.
    expect(blue.map((t) => [t.tier.key, t.probability, t.contents.length])).toEqual([
      ['rare', 0.25, 1],
      ['common', 0.75, 1],
    ]);
  });
});

describe('the change history', () => {
  const v2 = () => {
    const snapshot = seedSnapshot();
    snapshot.tiers[1].weight = 2;
    return snapshot;
  };

  it('words the first version as the publish, newest first after it', async () => {
    // Stored out of order: the query's own order decides the chain.
    world.snapshots.unshift({
      boxDefinitionId: BOX,
      version: 2,
      snapshot: v2(),
      createdAt: new Date('2026-11-10T10:00:00Z'),
    });
    world.tiers = TIERS.map((t) => (t.key === 'rare' ? { ...t, weight: 2 } : t));
    theBox().version = 2;
    const page = await read();
    expect(page?.history.map((h) => [h.version, h.createdAt.toISOString(), h.changes])).toEqual([
      [2, '2026-11-10T10:00:00.000Z', ['Rare weight 1 → 2.']],
      [1, '2026-11-06T10:00:00.000Z', ['Published: 5 hats, weights 3 / 1 (Common / Rare).']],
    ]);
    expect(page?.historyComplete).toBe(true);
    expect(errorsLogged()).toEqual([]);
  });

  it('skips and logs an unreadable snapshot', async () => {
    world.snapshots.unshift({
      boxDefinitionId: BOX,
      version: 0,
      snapshot: { tiers: 'nope' },
      createdAt: new Date(),
    });
    const page = await read();
    expect(page?.history.map((h) => h.version)).toEqual([1]);
    expect(errorsLogged().map((e) => e.message)).toEqual(['unreadable odds snapshot']);
  });

  it('logs, and says, when the current version has no snapshot', async () => {
    theBox().version = 2;
    expect((await read())?.historyComplete).toBe(false);
    expect(errorsLogged().map((e) => e.message)).toEqual([
      'no odds snapshot for the current version',
    ]);
  });

  it('logs, and says, when the live box differs from its current snapshot', async () => {
    world.tiers = TIERS.map((t) => (t.key === 'rare' ? { ...t, weight: 2 } : t));
    expect((await read())?.historyComplete).toBe(false);
    expect(errorsLogged().map((e) => e.message)).toEqual([
      'odds snapshot differs from the live box',
    ]);
  });

  it('logs a drifted box once a minute, not on every view', async () => {
    theBox().version = 3;
    await read();
    await read();
    expect(errorsLogged()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    await read();
    expect(errorsLogged()).toHaveLength(2);
  });

  it('logs each drifted box and each version on its own', async () => {
    theBox().version = 3;
    await read();
    theBox().version = 4;
    await read();
    world.boxes.find((b) => b.id === OTHER_BOX)!.version = 2;
    await read({ boxDefinitionId: OTHER_BOX });
    expect(errorsLogged().map((e) => [e.boxDefinitionId, e.version])).toEqual([
      [BOX, 3],
      [BOX, 4],
      [OTHER_BOX, 2],
    ]);
  });

  it('logs nothing when the live box matches its snapshot', async () => {
    expect((await read())?.historyComplete).toBe(true);
    expect(errorsLogged()).toEqual([]);
  });
});

describe('describeSnapshotChange', () => {
  it('counts contents added, removed and moved, per tier', () => {
    const before = seedSnapshot();
    const after: BoxOddsSnapshotData = {
      tiers: before.tiers,
      contents: [
        { tier: 'common', cosmeticId: 1001 },
        { tier: 'rare', cosmeticId: 1002 },
        { tier: 'rare', cosmeticId: 1004 },
        { tier: 'rare', cosmeticId: 1005 },
        { tier: 'rare', cosmeticId: 1006 },
        { tier: 'rare', cosmeticId: 1007 },
      ],
    };
    expect(describeSnapshotChange(before, after, 'hat')).toEqual([
      '1 hat moved from Common to Rare.',
      '2 hats added to Rare.',
      '1 hat removed from Common.',
    ]);
  });

  it('names added, removed and renamed rarities', () => {
    const before = seedSnapshot();
    const after: BoxOddsSnapshotData = {
      tiers: [
        { key: 'common', name: 'Basic', weight: 3 },
        { key: 'epic', name: 'Epic', weight: 2 },
      ],
      contents: before.contents.filter((c) => c.tier === 'common'),
    };
    expect(describeSnapshotChange(before, after, 'hat')).toEqual([
      'Renamed Common to Basic.',
      'Added the Epic rarity, weight 2.',
      'Removed the Rare rarity.',
      '2 hats removed from Rare.',
    ]);
  });

  it('names a renamed rarity by its new name in content changes', () => {
    const before = seedSnapshot();
    const after: BoxOddsSnapshotData = {
      tiers: [{ key: 'common', name: 'Basic', weight: 3 }, before.tiers[1]],
      contents: [...before.contents.slice(1), { tier: 'common', cosmeticId: 1009 }],
    };
    expect(describeSnapshotChange(before, after, 'hat')).toEqual([
      'Renamed Common to Basic.',
      '1 hat added to Basic.',
      '1 hat removed from Basic.',
    ]);
  });

  it('says so when a version changes nothing', () => {
    expect(describeSnapshotChange(seedSnapshot(), seedSnapshot(), 'hat')).toEqual([
      'No change to the odds or contents.',
    ]);
  });
});

describe('snapshotsMatch', () => {
  // Live rows in an order unlike the snapshot's: tiers rarest first, contents shuffled.
  const live = () =>
    snapshotOfLiveBox(
      [...TIERS].reverse(),
      [...boxContents()]
        .reverse()
        .map((c) => ({ tierId: c.tierId, cosmeticId: c.reward.cosmeticId }))
    );

  it("reads the live box in the writer's own order, whatever order the rows come in", () => {
    expect(live()).toEqual(seedSnapshot());
    expect(snapshotsMatch(live(), seedSnapshot())).toBe(true);
  });

  it('orders contents by tier rank before cosmetic id, and tiers by id within a sort order', () => {
    const tiers = [
      { id: 2, key: 'b', name: 'B', weight: 1, sortOrder: 0 },
      { id: 1, key: 'a', name: 'A', weight: 1, sortOrder: 0 },
      { id: 3, key: 'c', name: 'C', weight: 1, sortOrder: 1 },
    ];
    expect(
      snapshotOfLiveBox(tiers, [
        { tierId: 3, cosmeticId: 1 },
        { tierId: 2, cosmeticId: 5 },
        { tierId: 1, cosmeticId: 9 },
      ])
    ).toEqual({
      tiers: [
        { key: 'a', name: 'A', weight: 1 },
        { key: 'b', name: 'B', weight: 1 },
        { key: 'c', name: 'C', weight: 1 },
      ],
      contents: [
        { tier: 'a', cosmeticId: 9 },
        { tier: 'b', cosmeticId: 5 },
        { tier: 'c', cosmeticId: 1 },
      ],
    });
  });

  it('matches a snapshot that lists the same contents in another order', () => {
    const shuffled = seedSnapshot();
    shuffled.contents.reverse();
    expect(snapshotsMatch(live(), shuffled)).toBe(true);
  });

  const changed: [string, (s: BoxOddsSnapshotData) => void][] = [
    ['a weight', (s) => (s.tiers[0].weight = 4)],
    ['a tier name', (s) => (s.tiers[0].name = 'Basic')],
    ['the tier order', (s) => s.tiers.reverse()],
    ['a moved content', (s) => (s.contents[0].tier = 'rare')],
    ['a missing content', (s) => s.contents.pop()],
    ['an extra content', (s) => s.contents.push({ tier: 'rare', cosmeticId: 1099 })],
  ];
  it.each(changed)('sees %s', (_, change) => {
    const snapshot = seedSnapshot();
    change(snapshot);
    expect(snapshotsMatch(live(), snapshot)).toBe(false);
  });
});
