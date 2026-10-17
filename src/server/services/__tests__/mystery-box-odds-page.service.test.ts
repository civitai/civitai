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

import type { BoxOddsSnapshotData } from '../mystery-box-odds-page.service';
import {
  describeSnapshotChange,
  getMysteryBoxOddsPage,
  snapshotOfLiveBox,
  snapshotsMatch,
} from '../mystery-box-odds-page.service';
import { getBoxPoolForUser } from '../mystery-box.service';
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

/** The snapshot the seed writes for the world below: tiers by sortOrder, contents by tier then cosmetic. */
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

let world: {
  box: {
    id: number;
    type: string;
    status: string;
    version: number;
    name: string;
    description: string | null;
    params: unknown;
  } | null;
  tiers: typeof TIERS;
  contents: ReturnType<typeof hat>[];
  snapshots: { version: number; snapshot: unknown; createdAt: Date }[];
  listing: { unitAmount: number } | null;
  blocked: unknown;
  owned: { userId: number; cosmeticId: number }[];
};

function installWorld() {
  const db = dbMock.dbRead;
  db.keyValue.findUnique.mockReset();
  db.keyValue.findUnique.mockImplementation(async () =>
    world.blocked === undefined ? null : { value: world.blocked }
  );
  db.itemDefinition.findUnique.mockReset();
  db.itemDefinition.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    world.box && world.box.id === where.id ? world.box : null
  );
  db.boxTier.findMany.mockReset();
  db.boxTier.findMany.mockImplementation(
    async ({ where }: { where: { boxDefinitionId: number } }) =>
      world.tiers
        .filter((t) => t.boxDefinitionId === where.boxDefinitionId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  );
  db.boxContent.findMany.mockReset();
  db.boxContent.findMany.mockImplementation(
    async ({ where }: { where: { boxDefinitionId: number; enabled: boolean } }) =>
      world.contents.filter(
        (c) => c.boxDefinitionId === where.boxDefinitionId && c.enabled === where.enabled
      )
  );
  db.boxOddsSnapshot.findMany.mockReset();
  db.boxOddsSnapshot.findMany.mockImplementation(async () =>
    [...world.snapshots].sort((a, b) => a.version - b.version)
  );
  db.cosmeticShopItem.findFirst.mockReset();
  db.cosmeticShopItem.findFirst.mockImplementation(async () => world.listing);
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
    .map(([entry]) => entry as { type?: string; name?: string; message?: string })
    .filter((entry) => entry.type === 'error' && entry.name === 'mystery-box-odds-page');

// The region list is cached for a minute per pod; each case starts past the last one's cache.
const base = new Date('2026-11-08T12:00:00Z').getTime();
let step = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(base + step++ * 5 * 60_000);
  world = {
    box: {
      id: BOX,
      type: 'box',
      status: 'published',
      version: 1,
      name: 'Birthday Box',
      description: 'A hat from your team.',
      params: { event: EVENT },
    },
    tiers: TIERS,
    contents: [
      hat(1, COMMON, 'Pink'),
      hat(2, COMMON, 'Pink'),
      hat(3, COMMON, 'Blue'),
      hat(4, RARE, 'Pink'),
      hat(5, RARE),
    ],
    snapshots: [
      { version: 1, snapshot: seedSnapshot(), createdAt: new Date('2026-11-06T10:00:00Z') },
    ],
    listing: { unitAmount: 500 },
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
    expect(page?.boxDefinitionId).toBe(BOX);
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
    expect(await read({ countryCode: 'US' })).not.toBeNull();
  });

  it('shows a draft box to nobody', async () => {
    world.box!.status = 'draft';
    expect(await read()).toBeNull();
  });

  it('shows an archived box, marked as no longer sold', async () => {
    world.box!.status = 'archived';
    expect((await read())?.archived).toBe(true);
  });

  it('is not a page for anything but a box', async () => {
    world.box!.type = 'cosmetic';
    expect(await read()).toBeNull();
    world.box = null;
    expect(await read()).toBeNull();
  });

  it('needs no event for a box without one', async () => {
    world.box!.params = {};
    const page = await read();
    expect(page?.event).toBeNull();
    expect(page?.teams).toEqual([]);
    expect(mocks.catalogAccess).not.toHaveBeenCalled();
  });
});

describe('what the odds page shows', () => {
  it("lists the event's teams that the box holds anything for, in the event's order", async () => {
    const page = await read();
    expect(page?.teams).toEqual(['Blue', 'Pink']);
    expect(page?.event).toEqual({ title: "Civitai's 4th Birthday" });
    expect(page?.price).toBe(500);
    expect(page?.noun).toBe('hat');
  });

  it('leaves out disabled contents', async () => {
    world.contents.push(hat(6, RARE, 'Pink', false));
    const page = await read();
    expect(page?.contents.map((c) => c.contentId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('calls the contents items when any is not a hat', async () => {
    world.contents[0].reward.cosmetic.type = 'Badge';
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
  it('words the first version as the publish, newest first after it', async () => {
    const v2 = seedSnapshot();
    v2.tiers[1].weight = 2;
    world.snapshots.push({ version: 2, snapshot: v2, createdAt: new Date('2026-11-10T10:00:00Z') });
    world.tiers = TIERS.map((t) => (t.key === 'rare' ? { ...t, weight: 2 } : t));
    world.box!.version = 2;
    const page = await read();
    expect(page?.history.map((h) => [h.version, h.changes])).toEqual([
      [2, ['Rare weight 1 → 2.']],
      [1, ['Published: 5 hats, weights 3 / 1 (Common / Rare).']],
    ]);
    expect(errorsLogged()).toEqual([]);
  });

  it('skips and logs an unreadable snapshot', async () => {
    world.snapshots.unshift({ version: 0, snapshot: { tiers: 'nope' }, createdAt: new Date() });
    const page = await read();
    expect(page?.history.map((h) => h.version)).toEqual([1]);
    expect(errorsLogged().map((e) => e.message)).toEqual(['unreadable odds snapshot']);
  });

  it('logs a current version with no snapshot', async () => {
    world.box!.version = 2;
    await read();
    expect(errorsLogged().map((e) => e.message)).toEqual([
      'no odds snapshot for the current version',
    ]);
  });

  it('logs a live box that differs from its current snapshot', async () => {
    world.tiers = TIERS.map((t) => (t.key === 'rare' ? { ...t, weight: 2 } : t));
    await read();
    expect(errorsLogged().map((e) => e.message)).toEqual([
      'odds snapshot differs from the live box',
    ]);
  });

  it('logs nothing when the live box matches its snapshot', async () => {
    await read();
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

  it('says so when a version changes nothing', () => {
    expect(describeSnapshotChange(seedSnapshot(), seedSnapshot(), 'hat')).toEqual([
      'No change to the odds or contents.',
    ]);
  });
});

describe('snapshotsMatch', () => {
  const live = () =>
    snapshotOfLiveBox(
      TIERS,
      world.contents.map((c) => ({ tierId: c.tierId, cosmeticId: c.reward.cosmeticId }))
    );

  it("reads the live box in the seed's own order", () => {
    expect(live()).toEqual(seedSnapshot());
    expect(snapshotsMatch(live(), seedSnapshot())).toBe(true);
  });

  it('sees a weight, a tier order, a moved content and a missing content', () => {
    const weight = seedSnapshot();
    weight.tiers[0].weight = 4;
    const order = seedSnapshot();
    order.tiers.reverse();
    const moved = seedSnapshot();
    moved.contents[0].tier = 'rare';
    const missing = seedSnapshot();
    missing.contents.pop();
    for (const changed of [weight, order, moved, missing])
      expect(snapshotsMatch(live(), changed)).toBe(false);
  });
});
